/**
 * ZeroGate — find out what happened before retrying.
 *
 * A side effect that leaves your process is not done when the call returns. It
 * is done when authoritative state says so. ZeroGate turns one provider
 * mutation into a transaction: preview it, bind consent to the exact payload,
 * refuse to retry blindly when the answer is lost, reconcile against provider
 * evidence, verify against authoritative state, compensate only when that is
 * provably safe, and sign a receipt for the whole thing.
 *
 * Two things do the work: {@link defineEffect} describes one operation, and
 * {@link TransactionEngine} runs it. Everything else below is supporting cast.
 *
 * @example
 * ```ts
 * import { TransactionEngine, defineEffect } from "zerogate";
 *
 * const engine = new TransactionEngine({ adapter: defineEffect({ ... }) });
 *
 * const result = await engine.run({
 *   input: { documentId: "doc_1", status: "published" },
 *   actor: { principalId: "u_1", agentId: "publisher", agentVersion: "1.0.0" },
 *   purpose: "Publish the release notes",
 *   finalize: () => notifySubscribers()
 * });
 *
 * result.transaction.state;      // VERIFIED_COMMITTED | VERIFIED_COMPENSATED | ...
 * result.forwardDispatchCount;   // 1, even if the acknowledgement was lost
 * ```
 */

/* -------------------------------------------------------------------------- */
/* The two things you need                                                    */
/* -------------------------------------------------------------------------- */

export {
  defineEffect,
  type CommitEvidence,
  type CompensateContext,
  type DefinedPreflight,
  type DispatchContext,
  type DispatchOutcome,
  type DispatchResult,
  type EffectDefinition,
  type EvidenceContext,
  type ProviderState
} from "./core/define-effect.js";

export {
  DEFAULT_POLICY_VERSION,
  TransactionEngine,
  assertCommitted,
  type Recovery,
  type Refusal,
  type RunInput,
  type TransactionResult,
  type WitnessSummary
} from "./core/transaction-engine.js";

/* -------------------------------------------------------------------------- */
/* Errors your dispatch function throws                                       */
/* -------------------------------------------------------------------------- */

export {
  ProviderSafeToRetryError,
  ProviderTimeoutAfterDispatchError,
  ZeroGateError,
  type ErrorCode
} from "./core/errors.js";

/* -------------------------------------------------------------------------- */
/* Verifying evidence                                                         */
/* -------------------------------------------------------------------------- */

export { ReceiptSigner, verifyReceipt } from "./core/receipt.js";
export { replayProjection, verifyEventChain, type ReplayedProjection } from "./core/event-ledger.js";
export { KeyStore, type KeyPairPem } from "./core/key-store.js";

/** Canonical hashing (RFC 8785 JCS). Use it to pin a contract digest in a test. */
export { canonicalize, hashCanonical } from "./core/canonical-json.js";

/* -------------------------------------------------------------------------- */
/* Persistence and approvals                                                  */
/* -------------------------------------------------------------------------- */

export {
  InMemoryEventLedger,
  type AppendEventInput,
  type EventLedger
} from "./core/event-ledger.js";

export { SqliteLedger, type SqliteLedgerAppendResult } from "./core/sqlite-ledger.js";

export {
  ApprovalAuthority,
  type ApprovalClaims,
  type SignedApproval
} from "./core/approval.js";

/* -------------------------------------------------------------------------- */
/* Types that appear in the signatures above                                  */
/* -------------------------------------------------------------------------- */

export type {
  Awaitable,
  EffectAdapter,
  Preflight,
  PreflightEvaluation
} from "./core/adapter.js";

export type {
  ActionRuntimeRecord,
  ActionState,
  Actor,
  DispatchEvidence,
  DispatchObservation,
  Finality,
  IntentEnvelope,
  IntentLimits,
  JsonValue,
  ManualRecoveryItem,
  MaterialDiff,
  Observation,
  OutcomeClassification,
  ReconciliationObservation,
  PublicLedgerEvent,
  Reconciliation,
  RecoveryPlan,
  ReceiptAction,
  ReceiptBody,
  ResourceScope,
  SignedReceipt,
  StateWitness,
  StoredLedgerEvent,
  TransactionRuntimeRecord,
  TransactionState,
  Verification,
  VerificationObservation
} from "./core/types.js";
