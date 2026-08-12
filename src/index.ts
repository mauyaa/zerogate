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
 * @example
 * ```ts
 * import { TransactionEngine, defineEffect } from "zerogate";
 *
 * const engine = new TransactionEngine({ adapter: defineEffect({ ... }) });
 * const result = await engine.run({
 *   input: { documentId: "doc_1", status: "published", tags: ["release"] },
 *   actor: { principalId: "u_1", agentId: "publisher", agentVersion: "1.0.0" },
 *   purpose: "Publish the release notes",
 *   finalize: async () => notifySubscribers()
 * });
 *
 * result.transaction.state; // VERIFIED_COMMITTED | VERIFIED_COMPENSATED | ...
 * ```
 */

export {
  TransactionEngine,
  type RunInput,
  type TransactionResult,
  type WitnessSummary
} from "./core/transaction-engine.js";

export {
  defineEffect,
  type CommitEvidence,
  type CompensateContext,
  type DefinedPreflight,
  type DispatchContext,
  type DispatchOutcome,
  type EffectDefinition,
  type EvidenceContext,
  type ProviderState
} from "./core/define-effect.js";

export type {
  AnyEffectAdapter,
  Awaitable,
  DispatchRequest,
  EffectAdapter,
  Preflight,
  PreflightEvaluation,
  RecoveryDispatchRequest
} from "./core/adapter.js";

export {
  ProviderSafeToRetryError,
  ProviderTimeoutAfterDispatchError,
  ZeroGateError,
  type ErrorCode
} from "./core/errors.js";

export {
  ApprovalAuthority,
  type ApprovalClaims,
  type SignedApproval
} from "./core/approval.js";

export { ReceiptSigner, verifyReceipt } from "./core/receipt.js";

export {
  InMemoryEventLedger,
  canonicalEventTime,
  replayProjection,
  verifyEventChain,
  type AppendEventInput,
  type EventLedger,
  type ReplayedProjection
} from "./core/event-ledger.js";

export { SqliteLedger, type SqliteLedgerAppendResult } from "./core/sqlite-ledger.js";

export { KeyStore, type KeyPairPem } from "./core/key-store.js";

export { canonicalize, hashCanonical, sha256, toJsonValue } from "./core/canonical-json.js";

export { containsLikelySecret, redactPaths } from "./core/redaction.js";

export { assertActionTransition, assertTransactionTransition } from "./core/state-machine.js";

export type {
  ActionRuntimeRecord,
  ActionState,
  Actor,
  DispatchEvidence,
  Finality,
  IntentEnvelope,
  IntentLimits,
  JsonPrimitive,
  JsonValue,
  MaterialDiff,
  OutcomeClassification,
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
  Verification
} from "./core/types.js";
