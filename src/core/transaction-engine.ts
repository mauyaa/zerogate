import { randomUUID } from "node:crypto";
import type { Awaitable, EffectAdapter, Preflight } from "./adapter.js";
import { ApprovalAuthority, type SignedApproval } from "./approval.js";
import { hashCanonical, toJsonValue } from "./canonical-json.js";
import { ZeroGateError } from "./errors.js";
import {
  InMemoryEventLedger,
  type AppendEventInput,
  type EventLedger
} from "./event-ledger.js";
import { ReceiptSigner } from "./receipt.js";
import { assertActionTransition, assertTransactionTransition } from "./state-machine.js";
import type {
  ActionRuntimeRecord,
  ActionState,
  Actor,
  Finality,
  IntentEnvelope,
  IntentLimits,
  JsonValue,
  SignedReceipt,
  StateWitness,
  StoredLedgerEvent,
  TransactionRuntimeRecord,
  TransactionState
} from "./types.js";

export interface WitnessSummary {
  observedAt: string;
  providerVersion: string;
  stateHash: string;
  strength: StateWitness<unknown>["strength"];
}

export interface TransactionResult {
  transaction: TransactionRuntimeRecord;
  action: ActionRuntimeRecord;
  preview: {
    diff: Array<Record<string, JsonValue>>;
    witness: WitnessSummary;
    payloadHash: string;
    actionSetRoot: string;
  };
  receipt: SignedReceipt;
  receiptPublicKeyPem: string;
  events: StoredLedgerEvent[];
  /** Redacted summary of authoritative provider state at the terminal step. */
  finalState: Record<string, JsonValue>;
  /**
   * How many times the engine dispatched the forward effect. A lost
   * acknowledgement must never raise this above 1.
   */
  forwardDispatchCount: number;
  reconciliationUsed: boolean;
  notes: string[];
}

export interface RunInput<TInput> {
  input: TInput;
  actor: Actor;
  /** Why this effect is being requested. Bound into the receipt. */
  purpose: string;
  tenantId?: string;
  environment?: IntentEnvelope["environment"];
  /**
   * A pre-issued, payload-bound approval. When omitted the engine self-issues
   * one through its own {@link ApprovalAuthority}, which is appropriate for
   * tests and for callers that have already gathered consent out of band.
   */
  approval?: SignedApproval;
  /**
   * Downstream work that must succeed for the effect to be allowed to stand.
   *
   * Runs after the effect is verified against authoritative provider state and
   * before the transaction is declared committed. If it throws, ZeroGate
   * compensates the verified effect instead of leaving it stranded — and still
   * refuses to compensate if that would overwrite state it does not own.
   */
  finalize?: () => Awaitable<void>;
  limits?: Partial<IntentLimits>;
  /** Transaction lifetime. Defaults to 900 seconds. */
  ttlSeconds?: number;
  /**
   * Identifies the approval policy this transaction was admitted under. It is
   * bound into the approval and recorded in the receipt, so set it when your
   * policy is not the built-in single-use payload-bound mandate.
   */
  policyVersion?: string;
}

/** The policy the built-in {@link ApprovalAuthority} implements. */
export const DEFAULT_POLICY_VERSION = "policy.human-approval.v1";

const TERMINAL_TRANSACTION_STATES = new Set<TransactionState>([
  "VERIFIED_COMMITTED",
  "VERIFIED_COMPENSATED",
  "MANUAL_RECOVERY_REQUIRED",
  "APPROVAL_DENIED",
  "PREFLIGHT_FAILED",
  "ABORTED",
  "EXPIRED"
]);

function asEventData(value: unknown): Record<string, JsonValue> {
  const json = toJsonValue(value);
  if (json === null || Array.isArray(json) || typeof json !== "object") {
    throw new Error("Ledger event data must be a JSON object");
  }
  return json;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes one provider effect as a verified transaction.
 *
 * The engine is deliberately ignorant of the provider. Everything it knows
 * about the operation arrives through an {@link EffectAdapter}, which is what
 * lets the same transaction semantics apply to any side effect that can answer
 * "did this commit?" from provider-side evidence.
 */
export class TransactionEngine<
  TInput,
  TPreflight extends Preflight<TState>,
  TState,
  TResult,
  TRecovery
> {
  public readonly adapter: EffectAdapter<TInput, TPreflight, TState, TResult, TRecovery>;
  public readonly ledger: EventLedger;
  public readonly approvalAuthority: ApprovalAuthority;
  public readonly receiptSigner: ReceiptSigner;

  public constructor(input: {
    adapter: EffectAdapter<TInput, TPreflight, TState, TResult, TRecovery>;
    ledger?: EventLedger;
    approvalAuthority?: ApprovalAuthority;
    receiptSigner?: ReceiptSigner;
  }) {
    this.adapter = input.adapter;
    this.ledger = input.ledger ?? new InMemoryEventLedger();
    this.approvalAuthority = input.approvalAuthority ?? new ApprovalAuthority();
    this.receiptSigner = input.receiptSigner ?? new ReceiptSigner();
  }

  private async appendEvent(input: AppendEventInput): Promise<StoredLedgerEvent> {
    const stableInput: AppendEventInput = {
      ...input,
      id: input.id ?? randomUUID(),
      time: input.time ?? new Date().toISOString()
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.ledger.append(stableInput);
      } catch (error: unknown) {
        if (!(error instanceof ZeroGateError) || !error.retryable || attempt === 3) throw error;
      }
    }
    throw new Error("Unreachable ledger retry state");
  }

  public async run(input: RunInput<TInput>): Promise<TransactionResult> {
    const canonicalInput = this.adapter.canonicalizeInput(input.input);
    const tenantId = input.tenantId ?? this.ledger.tenantId ?? "tenant_local";
    if (this.ledger.tenantId !== undefined && tenantId !== this.ledger.tenantId) {
      throw new ZeroGateError(
        "UNSUPPORTED",
        "The transaction tenant does not match the isolated ledger tenant",
        false
      );
    }
    const transactionId = randomUUID();
    const actionId = randomUUID();
    const logicalOperationId = `zg:${transactionId}:${actionId}:forward`;
    const policyVersion = input.policyVersion ?? DEFAULT_POLICY_VERSION;
    const createdAt = new Date();
    const ttlSeconds = input.ttlSeconds ?? 900;
    const limits: IntentLimits = {
      maxActions: 1,
      maxExternalMessages: 0,
      maxRuntimeSeconds: ttlSeconds,
      ...input.limits
    };
    const intent: IntentEnvelope = {
      schemaVersion: "1.0",
      tenantId,
      environment: input.environment ?? "test",
      actor: input.actor,
      purpose: input.purpose,
      resourceScope: [...this.adapter.resourceScope(canonicalInput)],
      limits,
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString()
    };
    const limitsHash = hashCanonical(limits);
    let transaction: TransactionRuntimeRecord = {
      transactionId,
      state: "DRAFT",
      intent,
      limitsHash,
      actionSetRoot: "pending",
      policyVersion,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString()
    };
    let action: ActionRuntimeRecord = {
      actionId,
      transactionId,
      operation: this.adapter.operation,
      logicalOperationId,
      payloadHash: "pending",
      contractDigest: this.adapter.contractDigest,
      state: "PROPOSED",
      attempts: [],
      observations: [],
      residualRisk: [...this.adapter.residualRisk]
    };
    const approvals: Array<Record<string, JsonValue>> = [];
    const manualRecovery: Array<Record<string, JsonValue>> = [];
    const providerRequestIds: string[] = [];
    const notes: string[] = [];
    let reconciliationUsed = false;
    let forwardDispatchCount = 0;
    let actionFinality: Finality = "UNKNOWN";

    await this.appendEvent({
      type: "dev.zerogate.transaction.created.v1",
      subject: transactionId,
      correlationId: transactionId,
      data: asEventData({
        transactionId,
        tenantId: intent.tenantId,
        environment: intent.environment,
        actor: intent.actor,
        resourceScope: intent.resourceScope,
        purpose: intent.purpose,
        expiresAt: intent.expiresAt,
        limitsHash,
        policyVersion
      })
    });

    const transitionTransaction = async (to: TransactionState, reason: string): Promise<void> => {
      const from = transaction.state;
      assertTransactionTransition(from, to);
      const updatedAt = new Date().toISOString();
      await this.appendEvent({
        type: "dev.zerogate.transaction.state_changed.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({ from, to, reason })
      });
      transaction = { ...transaction, state: to, updatedAt };
    };

    const transitionAction = async (to: ActionState, reason: string): Promise<void> => {
      const from = action.state;
      assertActionTransition(from, to);
      await this.appendEvent({
        type: "dev.zerogate.action.state_changed.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({ actionId, from, to, reason })
      });
      action = { ...action, state: to };
    };

    await transitionTransaction("PREFLIGHTING", "Authoritative preflight started");
    await transitionAction("PREFLIGHTING", "Provider state observation started");

    let preflight: TPreflight;
    let preflightRejection: ZeroGateError | undefined;
    try {
      const evaluation = await this.adapter.evaluatePreflight(canonicalInput);
      preflight = evaluation.preflight;
      preflightRejection = evaluation.rejection;
    } catch (error: unknown) {
      await transitionAction("PREFLIGHT_REJECTED", "Preflight failed");
      await transitionTransaction("PREFLIGHT_FAILED", "Preflight failed");
      throw error;
    }

    const finish = (): Promise<TransactionResult> =>
      this.finishResult({
        transaction,
        action,
        preflight,
        approvals,
        manualRecovery,
        providerRequestIds,
        actionFinality,
        notes,
        reconciliationUsed,
        forwardDispatchCount
      });
    if (preflightRejection !== undefined) {
      await transitionAction("PREFLIGHT_REJECTED", "Preflight failed");
      await transitionTransaction("PREFLIGHT_FAILED", "Preflight failed");
    }

    action = { ...action, payloadHash: preflight.payloadHash };
    const resourceWitnessHash = hashCanonical({
      providerVersion: preflight.witness.providerVersion,
      stateHash: preflight.witness.stateHash
    });
    const intentHash = hashCanonical(intent);
    const actionSetRoot = hashCanonical({
      transactionId,
      intentHash,
      orderedActions: [
        {
          actionId,
          operation: action.operation,
          payloadHash: action.payloadHash,
          contractDigest: action.contractDigest,
          resourceWitnessHash,
          dependencies: [],
          releaseConditions: []
        }
      ],
      limitsHash,
      policyVersion,
      expiresAt: intent.expiresAt
    });
    transaction = { ...transaction, actionSetRoot };
    const evidenceDiff = this.adapter.evidenceDiff(preflight);
    const witnessEvidence: WitnessSummary = {
      observedAt: preflight.witness.observedAt,
      providerVersion: preflight.witness.providerVersion,
      stateHash: preflight.witness.stateHash,
      strength: preflight.witness.strength
    };
    if (preflightRejection !== undefined) {
      action.observations.push(
        asEventData({
          kind: "preflight-rejection",
          reasonCode: preflightRejection.code,
          retryable: preflightRejection.retryable,
          dispatchBoundaryCrossed: false,
          witness: witnessEvidence
        })
      );
      notes.push(
        `Preflight rejected (${preflightRejection.code}); no provider request was dispatched.`
      );
      await this.appendEvent({
        type: "dev.zerogate.action.preflight_rejected.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({
          actionId,
          reasonCode: preflightRejection.code,
          retryable: preflightRejection.retryable,
          payloadHash: action.payloadHash,
          actionSetRoot,
          witness: witnessEvidence,
          dispatchBoundaryCrossed: false
        })
      });
      actionFinality = "VERIFIED";
      return finish();
    }
    action.observations.push(
      asEventData({
        kind: "preflight",
        witness: witnessEvidence,
        diff: evidenceDiff
      })
    );
    await this.appendEvent({
      type: "dev.zerogate.action.preflighted.v1",
      subject: transactionId,
      correlationId: transactionId,
      data: asEventData({
        actionId,
        payloadHash: action.payloadHash,
        contractDigest: action.contractDigest,
        actionSetRoot,
        resourceWitnessHash,
        witness: witnessEvidence,
        diff: evidenceDiff
      })
    });
    await transitionAction("PREFLIGHTED", "Preview and witness created");
    await transitionTransaction("READY", "All required actions preflighted");

    await transitionTransaction("AWAITING_APPROVAL", "A material mutation requires bound consent");
    await transitionAction("AWAITING_APPROVAL", "Awaiting payload-bound approval");
    const approvalBinding = {
      transactionId,
      actor: input.actor,
      approverId: input.actor.principalId,
      approvalLevel: "human-owner" as const,
      actionSetRoot,
      payloadHash: action.payloadHash,
      contractDigest: action.contractDigest,
      resourceWitnessHash,
      limitsHash,
      policyVersion
    };
    const approval =
      input.approval ?? this.approvalAuthority.issue({ ...approvalBinding, ttlSeconds: 300 });
    try {
      this.approvalAuthority.consume(approval, approvalBinding);
    } catch (error: unknown) {
      if (
        !(error instanceof ZeroGateError) ||
        (error.code !== "APPROVAL_EXPIRED" &&
          error.code !== "APPROVAL_MISMATCH" &&
          error.code !== "APPROVAL_REPLAYED")
      ) {
        throw error;
      }
      action.observations.push(
        asEventData({
          kind: "approval-rejection",
          reasonCode: error.code,
          retryable: error.retryable,
          dispatchBoundaryCrossed: false
        })
      );
      await this.appendEvent({
        type: "dev.zerogate.approval.rejected.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({
          actionId,
          reasonCode: error.code,
          retryable: error.retryable,
          dispatchBoundaryCrossed: false
        })
      });
      await transitionAction("CANCELLED", "Approval was rejected before dispatch");
      await transitionTransaction("APPROVAL_DENIED", "Approval was rejected before dispatch");
      notes.push(`Approval rejected (${error.code}); no provider request was dispatched.`);
      actionFinality = "VERIFIED";
      return finish();
    }
    approvals.push(
      asEventData({
        mandate: approval,
        publicKeyPem: this.approvalAuthority.publicKeyPem(),
        keyId: approval.keyId,
        consumedAt: new Date().toISOString()
      })
    );
    await this.appendEvent({
      type: "dev.zerogate.approval.consumed.v1",
      subject: transactionId,
      correlationId: transactionId,
      data: asEventData({
        approvalId: approval.claims.approvalId,
        actionId,
        actionSetRoot,
        payloadHash: action.payloadHash,
        mandateHash: hashCanonical(approval),
        approverId: approval.claims.approverId,
        policyVersion: approval.claims.policyVersion,
        resourceWitnessHash: approval.claims.resourceWitnessHash
      })
    });
    await transitionAction("ADMITTED", "Approval signature and exact binding verified");
    await transitionTransaction("COMMIT_REQUESTED", "Approved action set requested for commit");

    try {
      await this.adapter.assertFresh(preflight);
    } catch (error: unknown) {
      if (!(error instanceof ZeroGateError) || error.code !== "STALE_WITNESS") throw error;
      // The approved preview no longer describes reality. Nothing has been
      // dispatched, so this ends as a terminal receipt rather than an exception.
      action.observations.push(
        asEventData({
          kind: "staleness-rejection",
          reasonCode: error.code,
          retryable: error.retryable,
          dispatchBoundaryCrossed: false,
          details: toJsonValue(error.details)
        })
      );
      await this.appendEvent({
        type: "dev.zerogate.action.staleness_rejected.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({
          actionId,
          reasonCode: error.code,
          payloadHash: action.payloadHash,
          dispatchBoundaryCrossed: false,
          details: toJsonValue(error.details)
        })
      });
      await transitionAction("CANCELLED", "Provider state changed before dispatch");
      await transitionTransaction("ABORTED", "Provider state changed after the approved preview");
      notes.push(
        `Aborted before dispatch (${error.code}): ${error.message}. A fresh preview and approval are required.`
      );
      actionFinality = "VERIFIED";
      return finish();
    }
    await transitionAction("SCHEDULED", "Durable dispatch boundary recorded");
    await transitionTransaction("COMMITTING", "Dispatching admitted action");
    await transitionAction("DISPATCHING", "Provider request dispatched with stable operation ID");

    const forwardAttemptId = randomUUID();
    action.attempts.push(forwardAttemptId);
    await this.appendEvent({
      type: "dev.zerogate.action.dispatch_started.v1",
      subject: transactionId,
      correlationId: transactionId,
      data: asEventData({
        actionId,
        attemptId: forwardAttemptId,
        logicalOperationId,
        payloadHash: action.payloadHash
      })
    });

    try {
      forwardDispatchCount += 1;
      const evidence = await this.adapter.dispatch({
        preflight,
        logicalOperationId,
        attemptId: forwardAttemptId
      });
      if (evidence.providerRequestId !== undefined) providerRequestIds.push(evidence.providerRequestId);
      const dispatchObservation = asEventData({
        kind: "dispatch",
        logicalOperationId: evidence.logicalOperationId,
        attemptId: evidence.attemptId,
        providerRequestId: evidence.providerRequestId ?? null,
        classification: evidence.classification,
        observedAt: evidence.observedAt
      });
      action.observations.push(dispatchObservation);
      await this.appendEvent({
        type: "dev.zerogate.action.dispatch_reported.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({ actionId, evidence: dispatchObservation })
      });
      await transitionAction("REPORTED_SUCCEEDED", "Provider reported success");
    } catch (error: unknown) {
      if (error instanceof ZeroGateError && error.code === "PROVIDER_TIMEOUT_AFTER_DISPATCH") {
        await transitionAction("OUTCOME_UNKNOWN", "Acknowledgement was lost after dispatch");
        await transitionTransaction("RECONCILING", "Unknown outcome blocks ordinary retry");
        reconciliationUsed = true;
        notes.push("No blind retry was attempted after the lost acknowledgement.");
        await transitionAction("RECONCILING", "Querying provider operation evidence and state");
        const reconciliation = await this.adapter.reconcile(preflight, logicalOperationId);
        const reconciliationObservation = asEventData({
          kind: "reconciliation",
          resolved: reconciliation.resolved,
          committed: reconciliation.committed,
          finality: reconciliation.finality,
          reason: reconciliation.reason,
          observed:
            reconciliation.observed === undefined
              ? null
              : this.adapter.observationSummary(preflight, reconciliation.observed)
        });
        action.observations.push(reconciliationObservation);
        await this.appendEvent({
          type: "dev.zerogate.action.reconciled.v1",
          subject: transactionId,
          correlationId: transactionId,
          data: asEventData({
            actionId,
            logicalOperationId,
            reconciliation: reconciliationObservation
          })
        });
        if (!reconciliation.resolved || !reconciliation.committed) {
          await transitionAction("OUTCOME_UNKNOWN", "Provider outcome remains unresolved");
          await transitionTransaction(
            "MANUAL_RECOVERY_REQUIRED",
            "Unknown provider outcome could not be resolved"
          );
          actionFinality = "UNKNOWN";
          manualRecovery.push(
            asEventData({
              actionId,
              reason: reconciliation.reason,
              instruction: "Inspect authoritative provider state before any retry or recovery action."
            })
          );
          return finish();
        }
        providerRequestIds.push(...(reconciliation.providerRequestIds ?? []));
        await transitionAction("REPORTED_SUCCEEDED", "Reconciliation proved the provider committed once");
        await transitionTransaction("VERIFYING", "Reconciled effect requires postcondition verification");
      } else {
        await transitionAction("PROVIDER_REJECTED", "Provider definitively rejected the request");
        await transitionTransaction("FAILURE_DETECTED", "Provider rejected the required action");
        actionFinality = "VERIFIED";
        manualRecovery.push(asEventData({ actionId, reason: errorMessage(error) }));
        await transitionTransaction("MANUAL_RECOVERY_REQUIRED", "No committed effect to compensate");
        return finish();
      }
    }

    if (transaction.state === "COMMITTING") {
      await transitionTransaction("VERIFYING", "A provider response is evidence, not final truth");
    }
    await transitionAction("VERIFYING", "Reading authoritative provider state");

    const verification = await this.adapter.verify(preflight);
    const verificationObservation = asEventData({
      kind: "verification",
      ok: verification.ok,
      finality: verification.finality,
      reason: verification.reason ?? null,
      observed: this.adapter.observationSummary(preflight, verification.observed)
    });
    action.observations.push(verificationObservation);
    await this.appendEvent({
      type: "dev.zerogate.action.verified.v1",
      subject: transactionId,
      correlationId: transactionId,
      data: asEventData({ actionId, verification: verificationObservation })
    });
    if (!verification.ok) {
      await transitionAction("VERIFICATION_FAILED", verification.reason ?? "Postcondition verification failed");
      await transitionTransaction("FAILURE_DETECTED", "Provider postcondition did not match the admitted payload");
      actionFinality = verification.finality;
    } else {
      await transitionAction("VERIFIED_SUCCEEDED", "Authoritative provider state matches the expected postcondition");
      actionFinality = verification.finality;
    }

    let finalizeError: unknown;
    if (verification.ok && input.finalize !== undefined) {
      try {
        await input.finalize();
      } catch (error: unknown) {
        finalizeError = error;
      }
    }

    if (verification.ok && finalizeError === undefined) {
      await transitionTransaction("VERIFIED_COMMITTED", "All required effects verified");
      return finish();
    }

    if (transaction.state === "VERIFYING") {
      await transitionTransaction("FAILURE_DETECTED", "Downstream work failed after the effect verified");
      notes.push(
        `The verified effect is being compensated because downstream work failed: ${errorMessage(finalizeError)}`
      );
      await this.appendEvent({
        type: "dev.zerogate.transaction.finalize_failed.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({ actionId, reason: errorMessage(finalizeError) })
      });
    }
    if (action.state === "VERIFIED_SUCCEEDED" || action.state === "VERIFICATION_FAILED") {
      await transitionAction("COMPENSATION_PLANNED", "Transaction failure requires a safe recovery decision");
    }
    await transitionTransaction("COMPENSATING", "Planning compensating action against current provider state");

    const recoveryPlan = await this.adapter.planRecovery(preflight);
    const recoveryPlanObservation = asEventData({
      kind: "recovery_plan",
      safe: recoveryPlan.safe,
      reason: recoveryPlan.reason,
      payloadHash: recoveryPlan.payload === undefined ? null : hashCanonical(recoveryPlan.payload)
    });
    action.observations.push(recoveryPlanObservation);
    await this.appendEvent({
      type: "dev.zerogate.recovery.planned.v1",
      subject: transactionId,
      correlationId: transactionId,
      data: asEventData({ actionId, recoveryPlan: recoveryPlanObservation })
    });

    if (!recoveryPlan.safe || recoveryPlan.payload === undefined) {
      await transitionAction("COMPENSATION_BLOCKED", recoveryPlan.reason);
      await transitionTransaction(
        "MANUAL_RECOVERY_REQUIRED",
        "Automatic compensation would overwrite newer or unverified provider state"
      );
      const currentState = await this.adapter.observeCurrentState(preflight);
      manualRecovery.push(
        asEventData({
          actionId,
          reason: recoveryPlan.reason,
          currentState: this.adapter.observationSummary(preflight, currentState),
          suggestedAction: "Review the current state and apply a human-approved corrective update."
        })
      );
      return finish();
    }

    await transitionAction("COMPENSATING", "Recovery preconditions hold against current state");
    const recoveryAttemptId = randomUUID();
    const recoveryOperationId = `zg:${transactionId}:${actionId}:compensation`;
    await this.appendEvent({
      type: "dev.zerogate.recovery.dispatch_started.v1",
      subject: transactionId,
      correlationId: transactionId,
      data: asEventData({
        actionId,
        attemptId: recoveryAttemptId,
        logicalOperationId: recoveryOperationId,
        payloadHash: hashCanonical(recoveryPlan.payload)
      })
    });
    action.attempts.push(recoveryAttemptId);

    try {
      const recoveryEvidence = await this.adapter.executeRecovery({
        preflight,
        payload: recoveryPlan.payload,
        logicalOperationId: recoveryOperationId,
        attemptId: recoveryAttemptId
      });
      if (recoveryEvidence.providerRequestId !== undefined) {
        providerRequestIds.push(recoveryEvidence.providerRequestId);
      }
      const recoveryDispatchObservation = asEventData({
        kind: "compensation_dispatch",
        logicalOperationId: recoveryEvidence.logicalOperationId,
        attemptId: recoveryEvidence.attemptId,
        providerRequestId: recoveryEvidence.providerRequestId ?? null,
        classification: recoveryEvidence.classification,
        observedAt: recoveryEvidence.observedAt
      });
      action.observations.push(recoveryDispatchObservation);
      await this.appendEvent({
        type: "dev.zerogate.recovery.dispatched.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({ actionId, recoveryEvidence: recoveryDispatchObservation })
      });
      await transitionAction("COMPENSATION_REPORTED_SUCCEEDED", "Provider reported compensation success");
    } catch (error: unknown) {
      if (error instanceof ZeroGateError && error.code === "PROVIDER_TIMEOUT_AFTER_DISPATCH") {
        await transitionAction(
          "COMPENSATION_UNKNOWN",
          "Compensation acknowledgement was lost after dispatch"
        );
        reconciliationUsed = true;
        notes.push("Compensation entered unknown outcome and was reconciled before any retry.");
        await transitionAction(
          "COMPENSATION_RECONCILING",
          "Querying provider evidence for the compensation operation"
        );
        const recoveryReconciliation = await this.adapter.reconcileRecovery(
          preflight,
          recoveryPlan.payload,
          recoveryOperationId
        );
        const recoveryReconciliationObservation = asEventData({
          kind: "compensation_reconciliation",
          resolved: recoveryReconciliation.resolved,
          committed: recoveryReconciliation.committed,
          finality: recoveryReconciliation.finality,
          reason: recoveryReconciliation.reason,
          observed:
            recoveryReconciliation.observed === undefined
              ? null
              : this.adapter.observationSummary(preflight, recoveryReconciliation.observed)
        });
        action.observations.push(recoveryReconciliationObservation);
        await this.appendEvent({
          type: "dev.zerogate.recovery.reconciled.v1",
          subject: transactionId,
          correlationId: transactionId,
          data: asEventData({
            actionId,
            logicalOperationId: recoveryOperationId,
            reconciliation: recoveryReconciliationObservation
          })
        });
        if (!recoveryReconciliation.resolved || !recoveryReconciliation.committed) {
          await transitionAction("COMPENSATION_FAILED", "Compensation outcome could not be resolved");
          await transitionTransaction("MANUAL_RECOVERY_REQUIRED", "Compensation outcome remains unknown");
          actionFinality = "UNKNOWN";
          manualRecovery.push(
            asEventData({
              actionId,
              reason: recoveryReconciliation.reason,
              instruction: "Inspect authoritative provider state before any compensation retry."
            })
          );
          return finish();
        }
        providerRequestIds.push(...(recoveryReconciliation.providerRequestIds ?? []));
        await transitionAction(
          "COMPENSATION_REPORTED_SUCCEEDED",
          "Reconciliation proved compensation committed once"
        );
      } else if (error instanceof ZeroGateError && error.code === "COMPENSATION_BLOCKED") {
        await transitionAction("COMPENSATION_BLOCKED", error.message);
        await transitionTransaction(
          "MANUAL_RECOVERY_REQUIRED",
          "Provider state changed before conditional compensation"
        );
        manualRecovery.push(
          asEventData({
            actionId,
            reason: error.message,
            instruction: "Review current provider state; automatic compensation was not dispatched."
          })
        );
        return finish();
      } else {
        await transitionAction("COMPENSATION_FAILED", errorMessage(error));
        await transitionTransaction(
          "MANUAL_RECOVERY_REQUIRED",
          "Compensation dispatch did not produce a verified recovery"
        );
        manualRecovery.push(
          asEventData({
            actionId,
            reason: errorMessage(error),
            instruction: "Inspect provider evidence and continue from the recovery packet."
          })
        );
        return finish();
      }
    }

    await transitionAction("COMPENSATION_VERIFYING", "Reading provider state after compensation");
    await transitionTransaction("VERIFYING_RECOVERY", "Recovery must be verified before terminal success");

    const recoveryVerification = await this.adapter.verifyRecovery(preflight, recoveryPlan.payload);
    const recoveryVerificationObservation = asEventData({
      kind: "recovery_verification",
      ok: recoveryVerification.ok,
      finality: recoveryVerification.finality,
      reason: recoveryVerification.reason ?? null,
      observed: this.adapter.observationSummary(preflight, recoveryVerification.observed)
    });
    action.observations.push(recoveryVerificationObservation);
    await this.appendEvent({
      type: "dev.zerogate.recovery.verified.v1",
      subject: transactionId,
      correlationId: transactionId,
      data: asEventData({ actionId, recoveryVerification: recoveryVerificationObservation })
    });
    if (!recoveryVerification.ok) {
      await transitionAction(
        "COMPENSATION_FAILED",
        recoveryVerification.reason ?? "Recovery postcondition failed"
      );
      await transitionTransaction(
        "MANUAL_RECOVERY_REQUIRED",
        "Provider state did not prove successful recovery"
      );
      actionFinality = recoveryVerification.finality;
      manualRecovery.push(
        asEventData({
          actionId,
          reason: recoveryVerification.reason ?? "Recovery verification failed",
          instruction: "Inspect the provider state and continue from the recovery packet."
        })
      );
    } else {
      await transitionAction("VERIFIED_COMPENSATED", "Authoritative state proves the recovery postcondition");
      await transitionTransaction("VERIFIED_COMPENSATED", "All required compensations verified");
      actionFinality = "VERIFIED";
    }

    return finish();
  }

  private async finishResult(input: {
    transaction: TransactionRuntimeRecord;
    action: ActionRuntimeRecord;
    preflight: TPreflight;
    approvals: Array<Record<string, JsonValue>>;
    manualRecovery: Array<Record<string, JsonValue>>;
    providerRequestIds: string[];
    actionFinality: Finality;
    notes: string[];
    reconciliationUsed: boolean;
    forwardDispatchCount: number;
  }): Promise<TransactionResult> {
    const terminal = input.transaction.state;
    if (!TERMINAL_TRANSACTION_STATES.has(terminal)) {
      throw new Error(`Cannot issue terminal receipt for ${terminal}`);
    }
    await this.appendEvent({
      type: "dev.zerogate.transaction.terminal.v1",
      subject: input.transaction.transactionId,
      correlationId: input.transaction.transactionId,
      data: asEventData({
        finalStatus: terminal,
        actionId: input.action.actionId,
        actionStatus: input.action.state,
        finality: input.actionFinality,
        unresolvedItems: input.manualRecovery.length
      })
    });
    const chainRoot = await this.ledger.chainRoot(input.transaction.transactionId);
    const receipt = this.receiptSigner.sign(
      {
        schemaVersion: "1.0",
        transactionId: input.transaction.transactionId,
        finalStatus: terminal as SignedReceipt["finalStatus"],
        finality:
          terminal === "MANUAL_RECOVERY_REQUIRED" && input.actionFinality === "UNKNOWN"
            ? "UNKNOWN"
            : input.actionFinality,
        intentBinding: {
          tenantId: input.transaction.intent.tenantId,
          environment: input.transaction.intent.environment,
          actor: input.transaction.intent.actor,
          purpose: input.transaction.intent.purpose,
          resourceScope: input.transaction.intent.resourceScope,
          expiresAt: input.transaction.intent.expiresAt,
          limitsHash: input.transaction.limitsHash,
          actionSetRoot: input.transaction.actionSetRoot,
          policyVersion: input.transaction.policyVersion
        },
        actions: [
          {
            actionId: input.action.actionId,
            operation: input.action.operation,
            logicalOperationId: input.action.logicalOperationId,
            payloadHash: input.action.payloadHash,
            contractDigest: input.action.contractDigest,
            status: input.action.state,
            finality: input.actionFinality,
            attemptIds: input.action.attempts,
            providerRequestIds: [...new Set(input.providerRequestIds)],
            observations: input.action.observations,
            ...(input.action.state === "VERIFIED_COMPENSATED"
              ? { recovery: asEventData({ status: "verified", mode: "exact_restore_owned_fields" }) }
              : input.action.state === "COMPENSATION_BLOCKED"
                ? { recovery: asEventData({ status: "blocked", mode: "manual" }) }
                : {}),
            residualRisk: input.action.residualRisk
          }
        ],
        approvals: input.approvals,
        manualRecovery: input.manualRecovery
      },
      chainRoot
    );
    await this.appendEvent({
      type: "dev.zerogate.receipt.issued.v1",
      subject: input.transaction.transactionId,
      correlationId: input.transaction.transactionId,
      data: asEventData({
        receiptId: receipt.receiptId,
        finalStatus: receipt.finalStatus,
        signatureHash: hashCanonical(receipt.integrity.signature),
        coveredEventChainRoot: chainRoot,
        keyId: receipt.integrity.keyId
      })
    });
    const events = await this.ledger.list(input.transaction.transactionId);
    const finalState = this.adapter.observationSummary(
      input.preflight,
      await this.adapter.observeCurrentState(input.preflight)
    );
    return {
      transaction: input.transaction,
      action: input.action,
      preview: {
        diff: this.adapter.evidenceDiff(input.preflight),
        witness: {
          observedAt: input.preflight.witness.observedAt,
          providerVersion: input.preflight.witness.providerVersion,
          stateHash: input.preflight.witness.stateHash,
          strength: input.preflight.witness.strength
        },
        payloadHash: input.preflight.payloadHash,
        actionSetRoot: input.transaction.actionSetRoot
      },
      receipt,
      receiptPublicKeyPem: this.receiptSigner.publicKeyPem(),
      events,
      finalState,
      forwardDispatchCount: input.forwardDispatchCount,
      reconciliationUsed: input.reconciliationUsed,
      notes: input.notes
    };
  }
}
