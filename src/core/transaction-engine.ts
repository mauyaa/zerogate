import { randomUUID } from "node:crypto";
import type { Awaitable, EffectAdapter, Preflight } from "./adapter.js";
import { ApprovalAuthority, type SignedApproval } from "./approval.js";
import { hashCanonical, toJsonValue } from "./canonical-json.js";
import { ZeroGateError, type ErrorCode } from "./errors.js";
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
  ManualRecoveryItem,
  Observation,
  ResourceScope,
  SignedReceipt,
  StoredLedgerEvent,
  TransactionRuntimeRecord,
  TransactionState,
  WitnessSummary
} from "./types.js";

export type { WitnessSummary } from "./types.js";

/** Why a transaction was refused before anything left the process. */
export interface Refusal {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** Always false. A refusal happens before the dispatch boundary. */
  dispatched: false;
  /** The original error, when one was thrown rather than returned. */
  cause?: unknown;
}

/** What a human needs in order to resolve an unfinished transaction. */
export interface Recovery {
  reason: string;
  instruction: string;
  /** Ask the provider about this identifier; it is what evidence is keyed by. */
  logicalOperationId: string;
  resource: string;
  /**
   * Whether the effect may already have landed. False only when the provider
   * definitively rejected the request, so nothing can have committed.
   */
  effectMayHaveCommitted: boolean;
  /**
   * Whether authoritative state currently matches what the effect intended.
   * `true` with `effectMayHaveCommitted` means the change is present but
   * unattributed — something produced it, and the provider cannot say what.
   */
  observedMatchesExpected?: boolean;
}

export interface TransactionResult {
  transaction: TransactionRuntimeRecord;
  action: ActionRuntimeRecord;
  /**
   * Whether the intended effect is verified as committed against authoritative
   * provider state. Check this — every other outcome, including the ones that
   * mean "we do not know whether this happened", returns normally.
   */
  committed: boolean;
  /** One line describing the outcome, safe to log verbatim. */
  summary: string;
  /** Present when the transaction was refused before dispatch. */
  refusal?: Refusal;
  /** Present when the transaction ended in `MANUAL_RECOVERY_REQUIRED`. */
  recovery?: Recovery;
  preview: {
    diff: Array<Record<string, JsonValue>>;
    witness: WitnessSummary | null;
    payloadHash: string;
    actionSetRoot: string;
  };
  receipt: SignedReceipt;
  receiptPublicKeyPem: string;
  /**
   * `ephemeral` when the signing key was generated for this process and is now
   * gone, which makes the receipt unverifiable by anyone else. Supply a
   * `receiptSigner` built from a retained key to get `retained`.
   */
  receiptKeyRetention: "ephemeral" | "retained";
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

/**
 * Throws unless the effect is verified as committed.
 *
 * For callers that would rather handle one exception than a state machine.
 * The thrown error carries the original cause when there was one, so a bug in
 * an effect definition still arrives with its stack intact.
 */
export function assertCommitted(result: TransactionResult): void {
  if (result.committed) return;
  const error = new ZeroGateError(
    result.refusal?.code ?? "OUTCOME_UNRESOLVED",
    result.summary,
    result.refusal?.retryable ?? false,
    {
      transactionId: result.transaction.transactionId,
      state: result.transaction.state,
      ...(result.recovery === undefined ? {} : { recovery: result.recovery })
    }
  );
  if (result.refusal?.cause !== undefined) error.cause = result.refusal.cause;
  throw error;
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
 * Wraps anything an effect definition throws.
 *
 * A provider outcome arrives as a `ZeroGateError` and keeps its meaning. Any
 * other throw is a fault in the definition, and it is recorded as one rather
 * than being mistaken for something the provider said.
 */
function asZeroGateError(error: unknown): ZeroGateError {
  if (error instanceof ZeroGateError) return error;
  return new ZeroGateError("ADAPTER_FAILED", errorMessage(error), false);
}

/** Names the resource a human would go and look at. */
function describeResource(scope: ResourceScope | undefined, fallback: string): string {
  return scope === undefined ? fallback : `${scope.type}:${scope.id}`;
}

let ephemeralKeyWarningEmitted = false;

/**
 * Says once, out loud, that these receipts cannot be verified by anyone else.
 *
 * The default is convenient and silently worthless for audit, which is exactly
 * the combination that reaches production unnoticed.
 */
function warnAboutEphemeralSigningKey(): void {
  if (ephemeralKeyWarningEmitted) return;
  if (process.env["ZEROGATE_EPHEMERAL_KEY_WARNING"] === "off") return;
  ephemeralKeyWarningEmitted = true;
  process.emitWarning(
    "TransactionEngine is signing receipts with an ephemeral key that dies with this " +
      "process, so nobody will be able to verify them later. Pass receiptSigner: " +
      "ReceiptSigner.fromPem(...) with a retained key, or set " +
      "ZEROGATE_EPHEMERAL_KEY_WARNING=off if that is intended.",
    { code: "ZEROGATE_EPHEMERAL_RECEIPT_KEY" }
  );
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
  /** Whether receipts from this engine can outlive the process that made them. */
  public readonly receiptKeyRetention: "ephemeral" | "retained";

  public constructor(input: {
    adapter: EffectAdapter<TInput, TPreflight, TState, TResult, TRecovery>;
    ledger?: EventLedger;
    approvalAuthority?: ApprovalAuthority;
    /**
     * A signer built from a retained key, or the literal `"ephemeral"` to
     * accept unverifiable receipts deliberately and without the warning.
     */
    receiptSigner?: ReceiptSigner | "ephemeral";
  }) {
    this.adapter = input.adapter;
    this.ledger = input.ledger ?? new InMemoryEventLedger();
    this.approvalAuthority = input.approvalAuthority ?? new ApprovalAuthority();
    const signer = input.receiptSigner;
    this.receiptSigner = signer instanceof ReceiptSigner ? signer : new ReceiptSigner();
    this.receiptKeyRetention = signer instanceof ReceiptSigner ? "retained" : "ephemeral";
    // Saying "ephemeral" out loud is an informed choice; saying nothing is not.
    if (signer === undefined) warnAboutEphemeralSigningKey();
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
    const manualRecovery: ManualRecoveryItem[] = [];
    const providerRequestIds: string[] = [];
    const notes: string[] = [];
    let reconciliationUsed = false;
    let forwardDispatchCount = 0;
    let actionFinality: Finality = "UNKNOWN";
    let refusal: Refusal | undefined;
    const resourceLabel = describeResource(intent.resourceScope[0], this.adapter.operation);

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

    // Anything the definition throws here is still an outcome: it happened
    // before the dispatch boundary, so it ends as a signed refusal rather than
    // an exception with no record of what was refused.
    let evaluated: TPreflight | undefined;
    let preflightRejection: ZeroGateError | undefined;
    let preflightCause: unknown;
    try {
      const evaluation = await this.adapter.evaluatePreflight(canonicalInput);
      evaluated = evaluation.preflight;
      preflightRejection = evaluation.rejection;
    } catch (error: unknown) {
      preflightRejection = asZeroGateError(error);
      preflightCause = error;
    }

    let evidenceDiff: Array<Record<string, JsonValue>> = [];
    if (evaluated !== undefined && preflightRejection === undefined) {
      try {
        evidenceDiff = this.adapter.evidenceDiff(evaluated);
      } catch (error: unknown) {
        // The credential guard refuses here. Refusing is the outcome.
        preflightRejection = asZeroGateError(error);
        preflightCause = error;
      }
    }

    /** The witness as evidence records it: the observed state itself never travels. */
    const witnessSummary = (source: TPreflight): WitnessSummary => ({
      observedAt: source.witness.observedAt,
      providerVersion: source.witness.providerVersion,
      stateHash: source.witness.stateHash,
      strength: source.witness.strength
    });
    const witnessEvidence: WitnessSummary | null =
      evaluated === undefined ? null : witnessSummary(evaluated);

    const finish = (): Promise<TransactionResult> =>
      this.finishResult({
        transaction,
        action,
        preflight: evaluated,
        previewDiff: evidenceDiff,
        previewWitness: witnessEvidence,
        approvals,
        manualRecovery,
        providerRequestIds,
        actionFinality,
        notes,
        reconciliationUsed,
        forwardDispatchCount,
        refusal,
        resourceLabel
      });

    action = {
      ...action,
      payloadHash: evaluated?.payloadHash ?? hashCanonical(canonicalInput)
    };
    const resourceWitnessHash = hashCanonical({
      providerVersion: witnessEvidence?.providerVersion ?? "unobserved",
      stateHash: witnessEvidence?.stateHash ?? "unobserved"
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
    if (preflightRejection !== undefined) {
      await transitionAction("PREFLIGHT_REJECTED", "Preflight failed");
      await transitionTransaction("PREFLIGHT_FAILED", "Preflight failed");
      action.observations.push({
        kind: "preflight-rejection",
        reasonCode: preflightRejection.code,
        reason: preflightRejection.message,
        retryable: preflightRejection.retryable,
        dispatchBoundaryCrossed: false,
        witness: witnessEvidence
      });
      notes.push(
        `Preflight rejected (${preflightRejection.code}): ${preflightRejection.message} Nothing was dispatched.`
      );
      refusal = {
        code: preflightRejection.code,
        message: preflightRejection.message,
        retryable: preflightRejection.retryable,
        dispatched: false,
        ...(preflightCause === undefined ? {} : { cause: preflightCause })
      };
      await this.appendEvent({
        type: "dev.zerogate.action.preflight_rejected.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({
          actionId,
          reasonCode: preflightRejection.code,
          reason: preflightRejection.message,
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

    if (evaluated === undefined) {
      // Unreachable: a preflight that produced no preview always set a rejection.
      throw new Error("Preflight produced neither a preview nor a rejection");
    }
    const preflight: TPreflight = evaluated;
    action.observations.push({
      kind: "preflight",
      witness: witnessSummary(preflight),
      diff: evidenceDiff
    });
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
      action.observations.push({
        kind: "approval-rejection",
        reasonCode: error.code,
        reason: error.message,
        retryable: error.retryable,
        dispatchBoundaryCrossed: false
      });
      await this.appendEvent({
        type: "dev.zerogate.approval.rejected.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({
          actionId,
          reasonCode: error.code,
          reason: error.message,
          retryable: error.retryable,
          dispatchBoundaryCrossed: false
        })
      });
      await transitionAction("CANCELLED", "Approval was rejected before dispatch");
      await transitionTransaction("APPROVAL_DENIED", "Approval was rejected before dispatch");
      notes.push(`Approval rejected (${error.code}): ${error.message} Nothing was dispatched.`);
      refusal = {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        dispatched: false
      };
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
      action.observations.push({
        kind: "staleness-rejection",
        reasonCode: error.code,
        reason: error.message,
        retryable: error.retryable,
        dispatchBoundaryCrossed: false,
        details: toJsonValue(error.details)
      });
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
      refusal = {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        dispatched: false
      };
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
      const dispatchObservation: Observation = {
        kind: "dispatch",
        logicalOperationId: evidence.logicalOperationId,
        attemptId: evidence.attemptId,
        providerRequestId: evidence.providerRequestId ?? null,
        classification: evidence.classification,
        observedAt: evidence.observedAt
      };
      action.observations.push(dispatchObservation);
      await this.appendEvent({
        type: "dev.zerogate.action.dispatch_reported.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({ actionId, evidence: dispatchObservation })
      });
      await transitionAction("REPORTED_SUCCEEDED", "Provider reported success");
    } catch (error: unknown) {
      // A definition that classified the failure is believed. A definition that
      // threw something unclassified has told us nothing — and the request may
      // already have left, so the only honest reading is "unknown". Calling it
      // a rejection would assert that nothing committed, without evidence.
      const unclassified = !(error instanceof ZeroGateError);
      if (unclassified || error.code === "PROVIDER_TIMEOUT_AFTER_DISPATCH") {
        await transitionAction(
          "OUTCOME_UNKNOWN",
          unclassified
            ? "Dispatch threw an unclassified error, so the outcome is unknown"
            : "Acknowledgement was lost after dispatch"
        );
        await transitionTransaction("RECONCILING", "Unknown outcome blocks ordinary retry");
        reconciliationUsed = true;
        notes.push(
          unclassified
            ? `Dispatch threw an error it did not classify (${errorMessage(error)}), so the ` +
              "outcome is treated as unknown and reconciled rather than assumed. Throw " +
              "ProviderSafeToRetryError or ProviderTimeoutAfterDispatchError to say which it was."
            : "No blind retry was attempted after the lost acknowledgement."
        );
        await transitionAction("RECONCILING", "Querying provider operation evidence and state");
        const reconciliation = await this.adapter.reconcile(preflight, logicalOperationId);
        const reconciliationObservation: Observation = {
          kind: "reconciliation",
          resolved: reconciliation.resolved,
          committed: reconciliation.committed,
          finality: reconciliation.finality,
          reason: reconciliation.reason,
          observed:
            reconciliation.observed === undefined
              ? null
              : this.adapter.observationSummary(preflight, reconciliation.observed)
        };
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
          manualRecovery.push({
            actionId,
            reason: reconciliation.reason,
            instruction:
              `Ask the provider what happened to operation ${logicalOperationId} before retrying ` +
              `or correcting ${resourceLabel} by hand. ZeroGate will not dispatch it again.`
          });
          return finish();
        }
        providerRequestIds.push(...(reconciliation.providerRequestIds ?? []));
        await transitionAction("REPORTED_SUCCEEDED", "Reconciliation proved the provider committed once");
        await transitionTransaction("VERIFYING", "Reconciled effect requires postcondition verification");
      } else {
        await transitionAction("PROVIDER_REJECTED", "Provider definitively rejected the request");
        await transitionTransaction("FAILURE_DETECTED", "Provider rejected the required action");
        actionFinality = "VERIFIED";
        manualRecovery.push({
          actionId,
          reason: errorMessage(error),
          instruction:
            `The provider rejected the request outright, so nothing committed and there is ` +
            `nothing to undo. Fix the cause and run a fresh transaction against ${resourceLabel}.`
        });
        await transitionTransaction("MANUAL_RECOVERY_REQUIRED", "No committed effect to compensate");
        return finish();
      }
    }

    if (transaction.state === "COMMITTING") {
      await transitionTransaction("VERIFYING", "A provider response is evidence, not final truth");
    }
    await transitionAction("VERIFYING", "Reading authoritative provider state");

    const verification = await this.adapter.verify(preflight);
    const verificationObservation: Observation = {
      kind: "verification",
      ok: verification.ok,
      finality: verification.finality,
      reason: verification.reason ?? null,
      observed: this.adapter.observationSummary(preflight, verification.observed)
    };
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
    const recoveryPlanObservation: Observation = {
      kind: "recovery_plan",
      safe: recoveryPlan.safe,
      reason: recoveryPlan.reason,
      payloadHash: recoveryPlan.payload === undefined ? null : hashCanonical(recoveryPlan.payload)
    };
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
      manualRecovery.push({
        actionId,
        reason: recoveryPlan.reason,
        currentState: this.adapter.observationSummary(preflight, currentState),
        instruction:
          `The effect committed and was not undone. Review ${resourceLabel} and apply a ` +
          `human-approved corrective update; ZeroGate refused to overwrite state it does not own.`
      });
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
      const recoveryDispatchObservation: Observation = {
        kind: "compensation_dispatch",
        logicalOperationId: recoveryEvidence.logicalOperationId,
        attemptId: recoveryEvidence.attemptId,
        providerRequestId: recoveryEvidence.providerRequestId ?? null,
        classification: recoveryEvidence.classification,
        observedAt: recoveryEvidence.observedAt
      };
      action.observations.push(recoveryDispatchObservation);
      await this.appendEvent({
        type: "dev.zerogate.recovery.dispatched.v1",
        subject: transactionId,
        correlationId: transactionId,
        data: asEventData({ actionId, recoveryEvidence: recoveryDispatchObservation })
      });
      await transitionAction("COMPENSATION_REPORTED_SUCCEEDED", "Provider reported compensation success");
    } catch (error: unknown) {
      // Same rule as the forward dispatch: an unclassified throw is not
      // evidence that the compensation failed to land.
      const unclassifiedRecovery = !(error instanceof ZeroGateError);
      if (unclassifiedRecovery || error.code === "PROVIDER_TIMEOUT_AFTER_DISPATCH") {
        await transitionAction(
          "COMPENSATION_UNKNOWN",
          unclassifiedRecovery
            ? "Compensation threw an unclassified error, so its outcome is unknown"
            : "Compensation acknowledgement was lost after dispatch"
        );
        reconciliationUsed = true;
        notes.push(
          unclassifiedRecovery
            ? `Compensation threw an error it did not classify (${errorMessage(error)}), so its ` +
              "outcome is treated as unknown and reconciled rather than assumed."
            : "Compensation entered unknown outcome and was reconciled before any retry."
        );
        await transitionAction(
          "COMPENSATION_RECONCILING",
          "Querying provider evidence for the compensation operation"
        );
        const recoveryReconciliation = await this.adapter.reconcileRecovery(
          preflight,
          recoveryPlan.payload,
          recoveryOperationId
        );
        const recoveryReconciliationObservation: Observation = {
          kind: "compensation_reconciliation",
          resolved: recoveryReconciliation.resolved,
          committed: recoveryReconciliation.committed,
          finality: recoveryReconciliation.finality,
          reason: recoveryReconciliation.reason,
          observed:
            recoveryReconciliation.observed === undefined
              ? null
              : this.adapter.observationSummary(preflight, recoveryReconciliation.observed)
        };
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
          manualRecovery.push({
            actionId,
            reason: recoveryReconciliation.reason,
            instruction:
              `Ask the provider what happened to compensation ${recoveryOperationId} before ` +
              `touching ${resourceLabel}. The forward effect committed; the undo may also have.`
          });
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
        manualRecovery.push({
          actionId,
          reason: error.message,
          instruction:
            `Review ${resourceLabel} by hand. The compensation was never dispatched, because ` +
            `state moved and undoing would have overwritten someone else's change.`
        });
        return finish();
      } else {
        await transitionAction("COMPENSATION_FAILED", errorMessage(error));
        await transitionTransaction(
          "MANUAL_RECOVERY_REQUIRED",
          "Compensation dispatch did not produce a verified recovery"
        );
        manualRecovery.push({
          actionId,
          reason: errorMessage(error),
          instruction:
            `The compensation failed outright. The forward effect is still in place on ` +
            `${resourceLabel}; decide by hand whether to undo it.`
        });
        return finish();
      }
    }

    await transitionAction("COMPENSATION_VERIFYING", "Reading provider state after compensation");
    await transitionTransaction("VERIFYING_RECOVERY", "Recovery must be verified before terminal success");

    const recoveryVerification = await this.adapter.verifyRecovery(preflight, recoveryPlan.payload);
    const recoveryVerificationObservation: Observation = {
      kind: "recovery_verification",
      ok: recoveryVerification.ok,
      finality: recoveryVerification.finality,
      reason: recoveryVerification.reason ?? null,
      observed: this.adapter.observationSummary(preflight, recoveryVerification.observed)
    };
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
      manualRecovery.push({
        actionId,
        reason: recoveryVerification.reason ?? "Recovery verification failed",
        instruction:
          `The compensation was dispatched but ${resourceLabel} does not prove it landed. ` +
          `Read the provider state before dispatching anything else.`
      });
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
    /** Absent when the preview itself could not be built. */
    preflight: TPreflight | undefined;
    previewDiff: Array<Record<string, JsonValue>>;
    previewWitness: WitnessSummary | null;
    approvals: Array<Record<string, JsonValue>>;
    manualRecovery: ManualRecoveryItem[];
    providerRequestIds: string[];
    actionFinality: Finality;
    notes: string[];
    reconciliationUsed: boolean;
    forwardDispatchCount: number;
    refusal: Refusal | undefined;
    resourceLabel: string;
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
    const finalState = await this.observeFinalState(input.preflight);
    const recovery = buildRecovery({
      state: terminal,
      action: input.action,
      manualRecovery: input.manualRecovery,
      resourceLabel: input.resourceLabel
    });
    return {
      transaction: input.transaction,
      action: input.action,
      committed: terminal === "VERIFIED_COMMITTED",
      summary: summarize({
        state: terminal as SignedReceipt["finalStatus"],
        operation: input.action.operation,
        resourceLabel: input.resourceLabel,
        refusal: input.refusal,
        recovery
      }),
      ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
      ...(recovery === undefined ? {} : { recovery }),
      preview: {
        diff: input.previewDiff,
        witness: input.previewWitness,
        payloadHash: input.action.payloadHash,
        actionSetRoot: input.transaction.actionSetRoot
      },
      receipt,
      receiptPublicKeyPem: this.receiptSigner.publicKeyPem(),
      receiptKeyRetention: this.receiptKeyRetention,
      events,
      finalState,
      forwardDispatchCount: input.forwardDispatchCount,
      reconciliationUsed: input.reconciliationUsed,
      notes: input.notes
    };
  }

  /**
   * Reads provider state one last time for the result.
   *
   * This is reporting, not evidence: the transaction is already terminal and
   * signed. A provider that cannot be read here must not turn a completed
   * transaction into a thrown exception.
   */
  private async observeFinalState(
    preflight: TPreflight | undefined
  ): Promise<Record<string, JsonValue>> {
    if (preflight === undefined) return {};
    try {
      return this.adapter.observationSummary(
        preflight,
        await this.adapter.observeCurrentState(preflight)
      );
    } catch (error: unknown) {
      return { unavailable: errorMessage(error) };
    }
  }
}

/** Pulls the operator packet out of the recorded evidence, for the caller. */
function buildRecovery(input: {
  state: TransactionState;
  action: ActionRuntimeRecord;
  manualRecovery: ManualRecoveryItem[];
  resourceLabel: string;
}): Recovery | undefined {
  if (input.state !== "MANUAL_RECOVERY_REQUIRED") return undefined;
  const item = input.manualRecovery[0];
  if (item === undefined) return undefined;
  const reconciliation = [...input.action.observations]
    .reverse()
    .find(
      (
        observation
      ): observation is Extract<
        Observation,
        { kind: "reconciliation" | "compensation_reconciliation" }
      > =>
        observation.kind === "reconciliation" || observation.kind === "compensation_reconciliation"
    );
  const observed = reconciliation?.observed;
  const materialFields =
    observed !== null && observed !== undefined && Array.isArray(observed["materialFields"])
      ? (observed["materialFields"] as Array<{ matchesExpected?: boolean }>)
      : undefined;
  return {
    reason: item.reason,
    instruction: item.instruction,
    logicalOperationId: input.action.logicalOperationId,
    resource: input.resourceLabel,
    // A definitive provider rejection is the one unresolved outcome where
    // nothing can have landed.
    effectMayHaveCommitted: input.action.state !== "PROVIDER_REJECTED",
    ...(materialFields === undefined
      ? {}
      : {
          observedMatchesExpected: materialFields.every((field) => field.matchesExpected === true)
        })
  };
}

/** One line an on-call engineer can read without opening the receipt. */
function summarize(input: {
  state: SignedReceipt["finalStatus"];
  operation: string;
  resourceLabel: string;
  refusal: Refusal | undefined;
  recovery: Recovery | undefined;
}): string {
  const subject = `${input.operation} on ${input.resourceLabel}`;
  switch (input.state) {
    case "VERIFIED_COMMITTED":
      return `${subject} committed once and authoritative state proves it.`;
    case "VERIFIED_COMPENSATED":
      return `${subject} committed and was undone; authoritative state proves both.`;
    case "PREFLIGHT_FAILED":
    case "APPROVAL_DENIED":
    case "ABORTED":
      return `${subject} was refused before dispatch${
        input.refusal === undefined ? "" : ` (${input.refusal.code}): ${input.refusal.message}`
      }`;
    case "MANUAL_RECOVERY_REQUIRED":
      return input.recovery === undefined
        ? `${subject} is unresolved and needs a human.`
        : `${subject} needs a human: ${input.recovery.reason} ${input.recovery.instruction}`;
    case "EXPIRED":
      return `${subject} expired before it reached a terminal outcome.`;
  }
}
