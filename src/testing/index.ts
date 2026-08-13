/**
 * The chaos suite ZeroGate runs against itself, pointed at your effect.
 *
 * The library's own tests prove the engine behaves. They prove nothing about
 * *your* definition — and the part everyone gets wrong is `findEvidence`,
 * because the only way to discover it does not work is to lose an
 * acknowledgement in production.
 *
 * {@link verifyEffect} loses one on purpose, against your real provider, and
 * tells you whether the answer was recoverable.
 *
 * @example
 * ```ts
 * import test from "node:test";
 * import { assertEffectVerified, verifyEffect } from "zerogate/testing";
 *
 * test("publish survives the chaos suite", async () => {
 *   assertEffectVerified(
 *     await verifyEffect({
 *       setup: async () => ({ adapter: createPublishEffect(baseUrl), input: PUBLISH_INPUT })
 *     })
 *   );
 * });
 * ```
 */

import type {
  AnyEffectAdapter,
  Awaitable,
  DispatchRequest,
  Preflight,
  PreflightEvaluation
} from "../core/adapter.js";
import { hashCanonical } from "../core/canonical-json.js";
import { ProviderTimeoutAfterDispatchError } from "../core/errors.js";
import { TransactionEngine, type TransactionResult } from "../core/transaction-engine.js";
import type { Actor } from "../core/types.js";

/** One effect, with the provider state it expects, built fresh per scenario. */
export interface EffectUnderTest<TInput> {
  adapter: AnyEffectAdapter;
  input: TInput;
  /** Torn down after the scenario, whether it passed or not. */
  cleanup?: () => Awaitable<void>;
}

export interface VerifyEffectOptions<TInput> {
  /**
   * Builds a fresh effect and a provider in a known starting state.
   *
   * Called once per scenario. Each scenario really mutates the provider, so
   * returning shared state that is never reset will make later scenarios lie.
   */
  setup: () => Awaitable<EffectUnderTest<TInput>>;
  actor?: Actor;
  purpose?: string;
  /**
   * Changes provider state behind ZeroGate's back, simulating another writer.
   *
   * Supply it to run the compensation-safety scenario: an effect that undoes
   * itself over someone else's newer write is the failure mode compensation
   * exists to prevent. Without it, that scenario is skipped rather than faked.
   */
  concurrentEdit?: (input: TInput) => Awaitable<void>;
  /** Scenario names to leave out, when one genuinely does not apply. */
  skip?: readonly ScenarioName[];
}

export type ScenarioName =
  | "commits-once"
  | "canonical-input-is-stable"
  | "observation-is-stable"
  | "lost-acknowledgement-is-recoverable"
  | "undispatched-request-is-not-claimed"
  | "foreign-change-is-not-claimed"
  | "repeat-is-refused-as-no-op"
  | "downstream-failure-is-compensated"
  | "compensation-refuses-concurrent-edit";

export interface ScenarioResult {
  name: ScenarioName;
  status: "passed" | "failed" | "skipped";
  /** What the scenario did, and for a failure what to change. */
  detail: string;
}

export interface EffectVerificationReport {
  ok: boolean;
  scenarios: ScenarioResult[];
  /** Multi-line, ready to print. */
  summary: string;
}

const DEFAULT_ACTOR: Actor = {
  principalId: "zerogate-testing",
  agentId: "verify-effect",
  agentVersion: "1.0.0"
};

/**
 * Replaces one adapter method without touching the original object.
 *
 * A proxy rather than a spread, because an adapter may be a class instance
 * whose methods live on the prototype.
 */
function withDispatch(adapter: AnyEffectAdapter, dispatch: AnyEffectAdapter["dispatch"]): AnyEffectAdapter {
  return new Proxy(adapter, {
    get(target, property, receiver): unknown {
      if (property === "dispatch") return dispatch;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function engineFor(adapter: AnyEffectAdapter): TransactionEngine<unknown, never, never, never, never> {
  return new TransactionEngine({
    adapter,
    // These receipts exist for the length of one assertion.
    receiptSigner: "ephemeral"
  }) as unknown as TransactionEngine<unknown, never, never, never, never>;
}

function describe(result: TransactionResult): string {
  return `${result.transaction.state} (${result.summary})`;
}

export async function verifyEffect<TInput>(
  options: VerifyEffectOptions<TInput>
): Promise<EffectVerificationReport> {
  const actor = options.actor ?? DEFAULT_ACTOR;
  const purpose = options.purpose ?? "Verify this effect against the ZeroGate chaos suite";
  const skip = new Set<ScenarioName>(options.skip ?? []);
  const scenarios: ScenarioResult[] = [];

  const run = async (
    name: ScenarioName,
    body: (subject: EffectUnderTest<TInput>) => Promise<Omit<ScenarioResult, "name">>
  ): Promise<void> => {
    if (skip.has(name)) {
      scenarios.push({ name, status: "skipped", detail: "Skipped by request." });
      return;
    }
    const subject = await options.setup();
    try {
      scenarios.push({ name, ...(await body(subject)) });
    } catch (error: unknown) {
      scenarios.push({
        name,
        status: "failed",
        detail: `The scenario itself threw: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      await subject.cleanup?.();
    }
  };

  const execute = (subject: EffectUnderTest<TInput>, over?: AnyEffectAdapter): Promise<TransactionResult> =>
    engineFor(over ?? subject.adapter).run({ input: subject.input, actor, purpose });

  /* An ordinary run must commit, exactly once. */
  await run("commits-once", async (subject) => {
    const result = await execute(subject);
    if (!result.committed) {
      return {
        status: "failed",
        detail: `A clean run did not commit: ${describe(result)}`
      };
    }
    if (result.forwardDispatchCount !== 1) {
      return {
        status: "failed",
        detail: `A clean run dispatched ${result.forwardDispatchCount} times; it must dispatch once.`
      };
    }
    return { status: "passed", detail: "Committed once and authoritative state proved it." };
  });

  /* canonicalizeInput must be idempotent, or approvals bind to a moving target. */
  await run("canonical-input-is-stable", async (subject) => {
    const once = subject.adapter.canonicalizeInput(subject.input) as TInput;
    const twice = subject.adapter.canonicalizeInput(once) as TInput;
    return hashCanonical(once) === hashCanonical(twice)
      ? { status: "passed", detail: "canonicalizeInput is idempotent." }
      : {
          status: "failed",
          detail:
            "canonicalizeInput(canonicalizeInput(x)) differs from canonicalizeInput(x). " +
            "Approval binds to the payload hash, so an unstable canonical form makes an " +
            "approval fail to match the payload it was issued for."
        };
  });

  /* observe() must be pure, or the freshness re-check fails at random. */
  await run("observation-is-stable", async (subject) => {
    const observe = async (): Promise<Preflight<unknown>> => {
      const evaluation = (await subject.adapter.evaluatePreflight(
        subject.adapter.canonicalizeInput(subject.input)
      )) as PreflightEvaluation<Preflight<unknown>>;
      return evaluation.preflight;
    };
    const first = await observe();
    const second = await observe();
    return first.witness.stateHash === second.witness.stateHash
      ? { status: "passed", detail: "Two observations of unchanged state hash identically." }
      : {
          status: "failed",
          detail:
            "Observing unchanged provider state twice produced two different hashes. " +
            "Something time-varying is reaching the witness — a timestamp, a request ID, " +
            "an unordered collection. Strip it in normalizeState, or the freshness check " +
            "before dispatch will abort healthy transactions at random."
        };
  });

  /* The one that matters: can a lost acknowledgement be resolved without a retry? */
  await run("lost-acknowledgement-is-recoverable", async (subject) => {
    const adapter = withDispatch(subject.adapter, async (request: DispatchRequest<never>) => {
      // The write really happens. Only the answer is lost.
      await subject.adapter.dispatch(request);
      throw new ProviderTimeoutAfterDispatchError(
        "zerogate/testing: the acknowledgement was dropped on purpose"
      );
    });
    const result = await execute(subject, adapter);
    if (result.forwardDispatchCount !== 1) {
      return {
        status: "failed",
        detail: `The effect was dispatched ${result.forwardDispatchCount} times after one lost acknowledgement.`
      };
    }
    if (result.committed) {
      return {
        status: "passed",
        detail: "findEvidence proved the dispatch committed, and no second dispatch was made."
      };
    }
    return {
      status: "failed",
      detail:
        `A lost acknowledgement left this effect unresolved: ${describe(result)} ` +
        "The dispatch did commit, so findEvidence should have found it. Check that " +
        "dispatch sends logicalOperationId to the provider and that findEvidence looks " +
        "the same identifier up. Until this passes, every dropped connection in " +
        "production becomes a page for a human."
    };
  });

  /* The mirror image: evidence must never be claimed for something that never ran. */
  await run("undispatched-request-is-not-claimed", async (subject) => {
    const adapter = withDispatch(subject.adapter, () => {
      // Nothing is sent at all.
      throw new ProviderTimeoutAfterDispatchError(
        "zerogate/testing: the request never left, and the caller cannot know that"
      );
    });
    const result = await execute(subject, adapter);
    if (result.committed) {
      return {
        status: "failed",
        detail:
          "A request that was never dispatched was reported as committed. findEvidence is " +
          "answering from current state rather than from provider evidence keyed by " +
          "logicalOperationId, so anything at all could have produced that state."
      };
    }
    return {
      status: "passed",
      detail: "An operation that never ran was reported unresolved, not committed."
    };
  });

  /*
   * The one that separates evidence from wishful thinking.
   *
   * Somebody else makes exactly the change this effect intended, and then this
   * effect's own dispatch is lost. State now looks precisely as though the
   * effect succeeded. A definition that answers "did I commit?" by reading
   * state will say yes, and be wrong — the state was somebody else's. Only a
   * lookup keyed by logicalOperationId can tell the difference.
   */
  await run("foreign-change-is-not-claimed", async (subject) => {
    const foreignOperationId = "zerogate-testing:a-different-writer";
    const adapter = withDispatch(subject.adapter, async (request: DispatchRequest<never>) => {
      // The same change, under somebody else's operation ID.
      await subject.adapter.dispatch({ ...request, logicalOperationId: foreignOperationId });
      throw new ProviderTimeoutAfterDispatchError(
        "zerogate/testing: this attempt was lost, and the state you see is not yours"
      );
    });
    const result = await execute(subject, adapter);
    if (result.committed) {
      return {
        status: "failed",
        detail:
          "Another writer's change was claimed as this transaction's own. findEvidence is " +
          "reading current state rather than asking the provider about logicalOperationId, " +
          "so it will report success for effects it did not cause — and then compensation " +
          "will happily undo somebody else's work."
      };
    }
    return {
      status: "passed",
      detail:
        "An identical change made by somebody else was not attributed to this transaction."
    };
  });

  /* Running the same change twice must be refused, not dispatched again. */
  await run("repeat-is-refused-as-no-op", async (subject) => {
    const first = await execute(subject);
    if (!first.committed) {
      return {
        status: "skipped",
        detail: `The first run did not commit, so a repeat proves nothing: ${describe(first)}`
      };
    }
    const second = await execute(subject);
    if (second.transaction.state === "PREFLIGHT_FAILED") {
      return {
        status: "passed",
        detail: "Repeating a completed change was refused before dispatch as having no effect."
      };
    }
    return {
      status: "failed",
      detail:
        `Repeating a completed change produced ${describe(second)} instead of being refused ` +
        "as a no-op. expected() does not describe what dispatch actually leaves behind — so " +
        "every repeat writes again, and the diff in every receipt is fiction."
    };
  });

  /* Failing downstream work must undo a verified effect. */
  await run("downstream-failure-is-compensated", async (subject) => {
    const result = await engineFor(subject.adapter).run({
      input: subject.input,
      actor,
      purpose,
      finalize: () => {
        throw new Error("zerogate/testing: downstream work failed on purpose");
      }
    });
    if (result.transaction.state === "VERIFIED_COMPENSATED") {
      return {
        status: "passed",
        detail: "The verified effect was undone and authoritative state proved the undo."
      };
    }
    if (result.recovery?.reason.includes("no compensating operation") === true) {
      return {
        status: "skipped",
        detail:
          "This effect declares no compensate(), so it is never auto-undone. That is a " +
          "choice, not a fault — but downstream failures will always need a human."
      };
    }
    return {
      status: "failed",
      detail: `Downstream failure left ${describe(result)} rather than a verified compensation.`
    };
  });

  /* Compensation must refuse to overwrite a newer write it does not own. */
  await run("compensation-refuses-concurrent-edit", async (subject) => {
    const concurrentEdit = options.concurrentEdit;
    if (concurrentEdit === undefined) {
      return {
        status: "skipped",
        detail:
          "Supply concurrentEdit() to prove compensation refuses to overwrite a newer " +
          "write. It is the failure mode compensation exists to prevent."
      };
    }
    const result = await engineFor(subject.adapter).run({
      input: subject.input,
      actor,
      purpose,
      finalize: async () => {
        // Somebody else writes between verification and the undo.
        await concurrentEdit(subject.input);
        throw new Error("zerogate/testing: downstream work failed after a concurrent edit");
      }
    });
    if (result.transaction.state === "VERIFIED_COMPENSATED") {
      return {
        status: "failed",
        detail:
          "Compensation ran over a concurrent edit and reported success, which means it " +
          "overwrote a write it does not own. Narrow materialFields to the fields this " +
          "effect actually owns."
      };
    }
    return {
      status: "passed",
      detail: `Compensation was refused rather than overwriting newer state: ${describe(result)}`
    };
  });

  const failed = scenarios.filter((scenario) => scenario.status === "failed");
  const skipped = scenarios.filter((scenario) => scenario.status === "skipped");
  const heading =
    failed.length === 0
      ? `zerogate/testing: ${scenarios.length - skipped.length} scenarios passed` +
        (skipped.length === 0 ? "." : `, ${skipped.length} skipped.`)
      : `zerogate/testing: ${failed.length} of ${scenarios.length} scenarios failed.`;
  return {
    ok: failed.length === 0,
    scenarios,
    summary: [
      heading,
      ...scenarios.map(
        (scenario) =>
          `  ${scenario.status === "passed" ? "PASS" : scenario.status === "failed" ? "FAIL" : "SKIP"} ` +
          `${scenario.name}: ${scenario.detail}`
      )
    ].join("\n")
  };
}

/** Throws the report as one readable failure. For use inside a test runner. */
export function assertEffectVerified(report: EffectVerificationReport): void {
  if (report.ok) return;
  throw new Error(report.summary);
}
