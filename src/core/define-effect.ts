import type { Awaitable, EffectAdapter, Preflight, PreflightEvaluation } from "./adapter.js";
import { hashCanonical, toJsonValue } from "./canonical-json.js";
import { ZeroGateError } from "./errors.js";
import { findCredentialShape } from "./secret-guard.js";
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

/**
 * Provider state must be an object so material fields can be compared by name.
 *
 * Deliberately not `Record<string, unknown>`: that would force every caller to
 * add an index signature to types they already have.
 */
export type ProviderState = object;

export interface DispatchOutcome {
  /** The provider's own request/operation identifier, recorded in the receipt. */
  providerRequestId?: string;
  /** Raw provider result, kept for the caller. Never placed in a receipt. */
  result?: unknown;
}

/** Proof, from the provider, that one logical operation committed exactly once. */
export interface CommitEvidence {
  providerRequestId?: string;
  committedAt?: string;
}

export interface DispatchContext<TInput, TState> {
  readonly input: TInput;
  /** Authoritative state observed while building the approved preview. */
  readonly before: TState;
  /** State the effect is expected to produce. */
  readonly expected: TState;
  /**
   * Stable operation ID. Send it to the provider — as an idempotency key, a
   * client-supplied reference, or anything the provider echoes back — so that
   * {@link EffectDefinition.findEvidence} can later prove whether this exact
   * attempt committed.
   */
  readonly logicalOperationId: string;
  readonly attemptId: string;
  readonly payloadHash: string;
}

export interface EvidenceContext<TInput, TState> {
  readonly input: TInput;
  readonly before: TState;
  readonly expected: TState;
  readonly logicalOperationId: string;
  /** Set when asking about a compensation rather than the forward effect. */
  readonly restore?: Partial<TState>;
}

export interface CompensateContext<TInput, TState> {
  readonly input: TInput;
  readonly before: TState;
  readonly expected: TState;
  /** Field values that undo the forward effect. */
  readonly restore: Partial<TState>;
  readonly logicalOperationId: string;
  readonly attemptId: string;
}

export interface EffectDefinition<TInput, TState extends ProviderState> {
  /** Stable operation name, e.g. `github.issues.update`. */
  operation: string;
  /**
   * The pinned Effect Contract for this operation. Its canonical hash is
   * recorded in every receipt, so a contract change invalidates old approvals.
   */
  contract: unknown;
  /** Honest limits that remain even when everything succeeds. */
  residualRisk?: readonly string[];
  /**
   * State fields this effect claims ownership of. Only these are diffed,
   * verified, and restored — so a compensation never touches anything else.
   */
  materialFields: readonly string[];
  /** Material fields whose values are hashed rather than shown in evidence. */
  redactFields?: readonly string[];
  /** Strength of the freshness guarantee the witness provides. */
  witnessStrength?: StateWitness<TState>["strength"];

  /** Normalise input so equivalent requests hash identically. */
  canonicalizeInput?(input: TInput): TInput;
  /**
   * Normalise observed provider state before anything is compared.
   *
   * Comparison is exact, so representation differences that carry no meaning —
   * an unordered tag list, an unnormalised string — would otherwise read as
   * material changes and dispatch a mutation that changes nothing. Put those
   * rules here and every diff, verification, and restore stays consistent.
   */
  normalizeState?(state: TState): TState;
  /** Resources this effect may touch, bound into the intent and receipt. */
  resourceScope(input: TInput): readonly ResourceScope[];
  /** Read authoritative provider state. Must not mutate anything. */
  observe(input: TInput): Awaitable<TState>;
  /** A provider version marker for the witness, e.g. an ETag or `updated_at`. */
  version(state: TState): string;
  /** The state this effect is expected to produce. */
  expected(input: TInput, before: TState): TState;
  /**
   * Perform the effect.
   *
   * Throw {@link ProviderTimeoutAfterDispatchError} when the outcome is
   * genuinely unknown — that is the signal that makes ZeroGate reconcile
   * instead of retrying. Never guess.
   */
  dispatch(context: DispatchContext<TInput, TState>): Awaitable<DispatchOutcome>;
  /**
   * Ask the provider whether `logicalOperationId` committed. Return `undefined`
   * only when the provider genuinely cannot say — that answer keeps the
   * transaction unresolved rather than risking a double effect.
   */
  findEvidence(context: EvidenceContext<TInput, TState>): Awaitable<CommitEvidence | undefined>;
  /** Field values that undo the forward effect. Defaults to the witness values. */
  restore?(input: TInput, before: TState): Partial<TState>;
  /** Apply a compensating change. Omit to make the effect non-compensatable. */
  compensate?(context: CompensateContext<TInput, TState>): Awaitable<DispatchOutcome>;
}

export interface DefinedPreflight<TInput, TState> extends Preflight<TState> {
  readonly input: TInput;
  readonly before: TState;
  readonly expected: TState;
  readonly witness: StateWitness<TState>;
  readonly payloadHash: string;
  readonly diff: readonly MaterialDiff[];
}

function equalValue(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

function fieldValue<TState extends ProviderState>(state: TState, field: string): unknown {
  const value: unknown = (state as Record<string, unknown>)[field];
  // Copied so a caller cannot mutate provider state we are about to compare.
  return Array.isArray(value) ? [...(value as readonly unknown[])] : value;
}

/**
 * Builds an {@link EffectAdapter} from a small operation description.
 *
 * Everything that must be true for a side effect to be safely retried,
 * verified, and undone is implemented here once: canonical payload hashing,
 * witness capture, material-field diffing, a freshness re-check immediately
 * before dispatch, reconciliation that refuses to attribute state it cannot
 * prove is its own, verification against authoritative state, and compensation
 * that is blocked whenever the effect no longer owns what it would overwrite.
 *
 * A definition supplies only provider knowledge, never transaction semantics.
 */
export function defineEffect<TInput, TState extends ProviderState>(
  definition: EffectDefinition<TInput, TState>
): EffectAdapter<
  TInput,
  DefinedPreflight<TInput, TState>,
  TState,
  DispatchOutcome["result"],
  Partial<TState>
> {
  const materialFields = [...definition.materialFields];
  if (materialFields.length === 0) {
    throw new ZeroGateError(
      "UNSUPPORTED",
      `Effect '${definition.operation}' must declare at least one material field`,
      false
    );
  }
  const redactFields = new Set(definition.redactFields ?? []);
  const contractDigest = hashCanonical(definition.contract);
  const witnessStrength = definition.witnessStrength ?? "medium";

  type TPreflight = DefinedPreflight<TInput, TState>;

  const normalize = (state: TState): TState =>
    definition.normalizeState === undefined ? state : definition.normalizeState(state);

  /** Every read of provider state goes through here, so nothing is compared raw. */
  const observe = async (input: TInput): Promise<TState> => normalize(await definition.observe(input));

  const buildPreflight = async (input: TInput): Promise<TPreflight> => {
    const before = await observe(input);
    const expected = normalize(definition.expected(input, before));
    const diff: MaterialDiff[] = [];
    for (const field of materialFields) {
      const beforeValue = fieldValue(before, field);
      const afterValue = fieldValue(expected, field);
      if (!equalValue(beforeValue, afterValue)) {
        diff.push({
          field,
          before: toJsonValue(beforeValue),
          after: toJsonValue(afterValue)
        });
      }
    }
    const witness: StateWitness<TState> = {
      observedAt: new Date().toISOString(),
      providerVersion: definition.version(before),
      stateHash: hashCanonical(before),
      strength: witnessStrength,
      state: before
    };
    return {
      input,
      before,
      expected,
      witness,
      diff,
      payloadHash: hashCanonical(input)
    };
  };

  const restoreValues = (preflight: TPreflight): Partial<TState> => {
    if (definition.restore !== undefined) {
      return definition.restore(preflight.input, preflight.before);
    }
    const restore: Record<string, unknown> = {};
    for (const change of preflight.diff) {
      restore[change.field] = fieldValue(preflight.before, change.field);
    }
    return restore as Partial<TState>;
  };

  const compareFields = (
    observed: TState,
    target: (field: string) => unknown,
    fields: readonly string[],
    describe: (field: string) => string
  ): { ok: true } | { ok: false; reason: string } => {
    for (const field of fields) {
      if (!equalValue(fieldValue(observed, field), target(field))) {
        return { ok: false, reason: describe(field) };
      }
    }
    return { ok: true };
  };

  /** Material fields this effect actually intends to change. */
  const changedFields = (preflight: TPreflight): string[] =>
    preflight.diff.map((change) => change.field);

  const verifyForward = async (preflight: TPreflight): Promise<Verification<TState>> => {
    const observed = await observe(preflight.input);
    const outcome = compareFields(
      observed,
      (field) => fieldValue(preflight.expected, field),
      changedFields(preflight),
      (field) => `Expected postcondition did not hold for ${field}`
    );
    return outcome.ok
      ? { ok: true, observed, finality: "VERIFIED" }
      : { ok: false, observed, finality: "DISPUTED", reason: outcome.reason };
  };

  const verifyRecovery = async (
    preflight: TPreflight,
    restore: Partial<TState>
  ): Promise<Verification<TState>> => {
    const observed = await observe(preflight.input);
    const fields = Object.keys(restore);
    const outcome = compareFields(
      observed,
      (field) => (restore as Record<string, unknown>)[field],
      fields,
      (field) => `Recovery postcondition failed for ${field}`
    );
    return outcome.ok
      ? { ok: true, observed, finality: "VERIFIED" }
      : { ok: false, observed, finality: "DISPUTED", reason: outcome.reason };
  };

  return {
    operation: definition.operation,
    contractDigest,
    residualRisk: definition.residualRisk ?? [],

    canonicalizeInput(input: TInput): TInput {
      return definition.canonicalizeInput === undefined
        ? input
        : definition.canonicalizeInput(input);
    },

    resourceScope(input: TInput): readonly ResourceScope[] {
      return definition.resourceScope(input);
    },

    async evaluatePreflight(input: TInput): Promise<PreflightEvaluation<TPreflight>> {
      const preflight = await buildPreflight(input);
      if (preflight.diff.length === 0) {
        return {
          preflight,
          rejection: new ZeroGateError(
            "UNSUPPORTED",
            "The requested change has no material effect",
            false
          )
        };
      }
      return { preflight };
    },

    /**
     * Renders the preview diff for a receipt.
     *
     * A credential in a non-redacted field is refused rather than published: a
     * receipt is meant to be shared, so a token reaching one is disclosed to
     * everyone who ever reads it. This runs during preflight, before anything
     * is dispatched, so refusing costs nothing.
     */
    evidenceDiff(preflight: TPreflight): Array<Record<string, JsonValue>> {
      for (const change of preflight.diff) {
        if (redactFields.has(change.field)) continue;
        const kind = findCredentialShape(change.after) ?? findCredentialShape(change.before);
        if (kind !== undefined) {
          throw new ZeroGateError(
            "UNSUPPORTED",
            `Field '${change.field}' of '${definition.operation}' looks like a ${kind}, and evidence is not a safe place for one. Add '${change.field}' to redactFields so it is hashed instead of recorded.`,
            false,
            { field: change.field, credentialKind: kind }
          );
        }
      }
      return preflight.diff.map((change) =>
        redactFields.has(change.field)
          ? {
              field: change.field,
              redacted: true,
              beforeHash: hashCanonical(change.before),
              afterHash: hashCanonical(change.after)
            }
          : {
              field: change.field,
              before: change.before ?? null,
              after: change.after ?? null
            }
      );
    },

    observationSummary(preflight: TPreflight, observed: TState): Record<string, JsonValue> {
      const scope = definition.resourceScope(preflight.input)[0];
      return {
        resource: scope === undefined ? definition.operation : `${scope.type}:${scope.id}`,
        providerVersion: definition.version(observed),
        stateHash: hashCanonical(observed),
        materialFields: changedFields(preflight).map((field) => ({
          field,
          valueHash: hashCanonical(fieldValue(observed, field)),
          matchesExpected: equalValue(
            fieldValue(observed, field),
            fieldValue(preflight.expected, field)
          )
        }))
      };
    },

    observeCurrentState(preflight: TPreflight): Awaitable<TState> {
      return observe(preflight.input);
    },

    async assertFresh(preflight: TPreflight): Promise<void> {
      const current = await observe(preflight.input);
      const currentVersion = definition.version(current);
      if (
        currentVersion !== preflight.witness.providerVersion ||
        hashCanonical(current) !== preflight.witness.stateHash
      ) {
        throw new ZeroGateError(
          "STALE_WITNESS",
          "Provider state changed after the preview; a new preview and approval are required",
          false,
          {
            expectedVersion: preflight.witness.providerVersion,
            actualVersion: currentVersion
          }
        );
      }
    },

    async dispatch(request): Promise<DispatchEvidence<DispatchOutcome["result"]>> {
      const outcome = await definition.dispatch({
        input: request.preflight.input,
        before: request.preflight.before,
        expected: request.preflight.expected,
        logicalOperationId: request.logicalOperationId,
        attemptId: request.attemptId,
        payloadHash: request.preflight.payloadHash
      });
      return {
        logicalOperationId: request.logicalOperationId,
        attemptId: request.attemptId,
        ...(outcome.providerRequestId === undefined
          ? {}
          : { providerRequestId: outcome.providerRequestId }),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
        classification: "DEFINITIVE_SUCCESS",
        observedAt: new Date().toISOString()
      };
    },

    async reconcile(
      preflight: TPreflight,
      logicalOperationId: string
    ): Promise<Reconciliation<TState>> {
      const evidence = await definition.findEvidence({
        input: preflight.input,
        before: preflight.before,
        expected: preflight.expected,
        logicalOperationId
      });
      const verification = await verifyForward(preflight);
      if (evidence !== undefined) {
        return {
          resolved: true,
          committed: true,
          observed: verification.observed,
          finality: verification.finality,
          reason: verification.ok
            ? "Provider evidence and authoritative state confirm the effect committed once"
            : `Provider evidence proves the dispatch committed, but ${
                verification.reason ?? "state verification failed"
              }`,
          ...(evidence.providerRequestId === undefined
            ? {}
            : { providerRequestIds: [evidence.providerRequestId] })
        };
      }
      return {
        resolved: false,
        committed: false,
        observed: verification.observed,
        finality: "UNKNOWN",
        reason: verification.ok
          ? "The expected state is present, but no provider evidence attributes it to this transaction; retry and compensation remain blocked"
          : "The provider outcome could not be proven"
      };
    },

    verify(preflight: TPreflight): Promise<Verification<TState>> {
      return verifyForward(preflight);
    },

    async planRecovery(preflight: TPreflight): Promise<RecoveryPlan<Partial<TState>>> {
      if (definition.compensate === undefined) {
        return {
          safe: false,
          reason: `Effect '${definition.operation}' declares no compensating operation`
        };
      }
      const current = await observe(preflight.input);
      const outcome = compareFields(
        current,
        (field) => fieldValue(preflight.expected, field),
        changedFields(preflight),
        (field) =>
          `Current ${field} no longer matches this transaction's effect; automatic compensation would overwrite newer state`
      );
      if (!outcome.ok) {
        return { safe: false, reason: outcome.reason };
      }
      return {
        safe: true,
        reason: "Every field owned by this effect still matches the expected result",
        payload: restoreValues(preflight)
      };
    },

    async executeRecovery(request): Promise<DispatchEvidence<DispatchOutcome["result"]>> {
      if (definition.compensate === undefined) {
        throw new ZeroGateError(
          "COMPENSATION_BLOCKED",
          `Effect '${definition.operation}' declares no compensating operation`,
          false
        );
      }
      const outcome = await definition.compensate({
        input: request.preflight.input,
        before: request.preflight.before,
        expected: request.preflight.expected,
        restore: request.payload,
        logicalOperationId: request.logicalOperationId,
        attemptId: request.attemptId
      });
      return {
        logicalOperationId: request.logicalOperationId,
        attemptId: request.attemptId,
        ...(outcome.providerRequestId === undefined
          ? {}
          : { providerRequestId: outcome.providerRequestId }),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
        classification: "DEFINITIVE_SUCCESS",
        observedAt: new Date().toISOString()
      };
    },

    async reconcileRecovery(
      preflight: TPreflight,
      restore: Partial<TState>,
      logicalOperationId: string
    ): Promise<Reconciliation<TState>> {
      const evidence = await definition.findEvidence({
        input: preflight.input,
        before: preflight.before,
        expected: preflight.expected,
        logicalOperationId,
        restore
      });
      if (evidence === undefined) {
        return {
          resolved: false,
          committed: false,
          observed: await observe(preflight.input),
          finality: "UNKNOWN",
          reason: "No provider evidence can prove whether the compensation committed"
        };
      }
      const verification = await verifyRecovery(preflight, restore);
      return {
        resolved: true,
        committed: true,
        observed: verification.observed,
        finality: verification.finality,
        reason: verification.ok
          ? "Provider evidence and authoritative state prove the compensation committed once"
          : `The compensation committed, but ${
              verification.reason ?? "its recovery postcondition is disputed"
            }`,
        ...(evidence.providerRequestId === undefined
          ? {}
          : { providerRequestIds: [evidence.providerRequestId] })
      };
    },

    verifyRecovery(preflight: TPreflight, restore: Partial<TState>): Promise<Verification<TState>> {
      return verifyRecovery(preflight, restore);
    }
  };
}
