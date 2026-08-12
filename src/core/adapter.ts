import type { ZeroGateError } from "./errors.js";
import type {
  DispatchEvidence,
  JsonValue,
  MaterialDiff,
  Reconciliation,
  RecoveryPlan,
  ResourceScope,
  StateWitness,
  Verification
} from "./types.js";

export type Awaitable<T> = T | Promise<T>;

/**
 * The minimum shape the engine requires from an adapter's preflight result.
 *
 * Adapters are free to carry extra operation-specific fields; the engine only
 * reads the three below, so it never needs to understand the operation itself.
 */
export interface Preflight<TState> {
  /** Authoritative provider state observed while building the preview. */
  readonly witness: StateWitness<TState>;
  /** Hash of the canonical payload that approval will be bound to. */
  readonly payloadHash: string;
  /** Material changes the operation intends to make. Empty means "no effect". */
  readonly diff: readonly MaterialDiff[];
}

export interface PreflightEvaluation<TPreflight> {
  readonly preflight: TPreflight;
  /**
   * Set when the operation is refused before any dispatch. Returning a
   * rejection rather than throwing lets the engine record the preview evidence
   * that justified the refusal.
   */
  readonly rejection?: ZeroGateError;
}

export interface DispatchRequest<TPreflight> {
  readonly preflight: TPreflight;
  /** Stable ID that must be recoverable from provider evidence later. */
  readonly logicalOperationId: string;
  readonly attemptId: string;
}

export interface RecoveryDispatchRequest<TPreflight, TRecovery> {
  readonly preflight: TPreflight;
  readonly payload: TRecovery;
  readonly logicalOperationId: string;
  readonly attemptId: string;
}

/**
 * The contract between the ZeroGate engine and one provider operation.
 *
 * The engine owns transaction semantics: previewing, binding approval to an
 * exact payload, refusing to retry blindly, reconciling unknown outcomes,
 * verifying against authoritative state, compensating only when it is provably
 * safe, and signing a receipt. It owns none of the provider knowledge.
 *
 * An adapter supplies that knowledge, and it must obey four rules:
 *
 * 1. `dispatch` throws {@link ProviderTimeoutAfterDispatchError} when the
 *    outcome is genuinely unknown. It must never guess success or failure.
 * 2. `reconcile` answers "did my dispatch commit?" from provider-side evidence
 *    keyed by `logicalOperationId` — not from state that anything else could
 *    have produced.
 * 3. `verify` reads authoritative state. A provider success response is
 *    evidence, never proof.
 * 4. `planRecovery` returns `safe: false` whenever compensation could overwrite
 *    state that this transaction does not own.
 */
export interface EffectAdapter<
  TInput,
  TPreflight extends Preflight<TState>,
  TState,
  TResult,
  TRecovery
> {
  /** Stable operation name, e.g. `github.issues.update`. */
  readonly operation: string;
  /** Digest of the pinned Effect Contract this adapter implements. */
  readonly contractDigest: string;
  /**
   * Risks that remain even on the success path, recorded in every receipt.
   * State them plainly; they are the honest limits of the guarantee.
   */
  readonly residualRisk: readonly string[];

  /** Normalise input so an identical request always hashes identically. */
  canonicalizeInput(input: TInput): TInput;

  /** Resources this operation may touch, bound into the intent envelope. */
  resourceScope(input: TInput): readonly ResourceScope[];

  /** Observe authoritative state and build the preview to be approved. */
  evaluatePreflight(input: TInput): Awaitable<PreflightEvaluation<TPreflight>>;

  /** Redacted, receipt-safe rendering of the preview diff. */
  evidenceDiff(preflight: TPreflight): Array<Record<string, JsonValue>>;

  /** Redacted, receipt-safe rendering of an observed provider state. */
  observationSummary(preflight: TPreflight, observed: TState): Record<string, JsonValue>;

  /** Read current authoritative state, used when reporting terminal outcomes. */
  observeCurrentState(preflight: TPreflight): Awaitable<TState>;

  /**
   * Re-check that state still matches the witness, immediately before dispatch.
   * Throws `STALE_WITNESS` if anything moved since the preview was approved.
   */
  assertFresh(preflight: TPreflight): Awaitable<void>;

  dispatch(request: DispatchRequest<TPreflight>): Awaitable<DispatchEvidence<TResult>>;

  reconcile(
    preflight: TPreflight,
    logicalOperationId: string
  ): Awaitable<Reconciliation<TState>>;

  verify(preflight: TPreflight): Awaitable<Verification<TState>>;

  planRecovery(preflight: TPreflight): Awaitable<RecoveryPlan<TRecovery>>;

  executeRecovery(
    request: RecoveryDispatchRequest<TPreflight, TRecovery>
  ): Awaitable<DispatchEvidence<TResult>>;

  reconcileRecovery(
    preflight: TPreflight,
    payload: TRecovery,
    logicalOperationId: string
  ): Awaitable<Reconciliation<TState>>;

  verifyRecovery(preflight: TPreflight, payload: TRecovery): Awaitable<Verification<TState>>;
}

/** Any adapter, with its type parameters erased. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEffectAdapter = EffectAdapter<any, any, any, any, any>;
