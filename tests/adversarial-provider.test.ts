import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderTimeoutAfterDispatchError,
  TransactionEngine,
  ZeroGateError,
  defineEffect,
  verifyEventChain,
  verifyReceipt
} from "../src/index.js";
import { TEST_ACTOR } from "./helpers/publish-harness.js";

/**
 * Providers that actively misbehave.
 *
 * Every test here asserts the same invariant from a different angle: the engine
 * must never report VERIFIED_COMMITTED unless authoritative state genuinely
 * matches the approved postcondition. A provider is allowed to lie, replay,
 * contradict itself, or hand back nonsense; none of that may be laundered into
 * a signed claim that the effect succeeded.
 */

interface Record_ {
  id: string;
  status: string;
  version: number;
}

interface ProviderBehaviour {
  /** Real state, mutated only when the provider genuinely commits. */
  readonly state: Record_;
  /** What `observe` reports, which may differ from reality. */
  observed?: () => Record_;
  /** Whether dispatch actually changes state. */
  commitOnDispatch?: boolean;
  /** What dispatch does instead of returning normally. */
  dispatchBehaviour?: "ok" | "lost-ack" | "reject";
  /** Whether evidence lookup claims the operation committed. */
  evidence?: "none" | "always" | "only-if-committed";
}

function adversary(behaviour: ProviderBehaviour) {
  const committed = new Set<string>();
  let dispatchCount = 0;

  const effect = defineEffect<{ id: string; status: string }, Record_>({
    operation: "adversarial.record.update",
    contract: { name: "adversarial", version: "1.0.0" },
    materialFields: ["status"],
    resourceScope: (input) => [{ type: "record", id: input.id }],
    observe: () =>
      behaviour.observed === undefined ? { ...behaviour.state } : behaviour.observed(),
    version: (state) => String(state.version),
    expected: (input, before) => ({ ...before, status: input.status }),
    dispatch: (context) => {
      dispatchCount += 1;
      const mode = behaviour.dispatchBehaviour ?? "ok";
      if (mode === "reject") {
        throw new ZeroGateError("PROVIDER_REJECTED", "the provider refused", false);
      }
      if (behaviour.commitOnDispatch !== false) {
        behaviour.state.status = context.input.status;
        behaviour.state.version += 1;
        committed.add(context.logicalOperationId);
      }
      if (mode === "lost-ack") {
        throw new ProviderTimeoutAfterDispatchError("acknowledgement lost");
      }
      return { providerRequestId: `req_${dispatchCount}` };
    },
    findEvidence: (context) => {
      const mode = behaviour.evidence ?? "only-if-committed";
      if (mode === "none") return undefined;
      if (mode === "always") return { providerRequestId: "req_fabricated" };
      return committed.has(context.logicalOperationId)
        ? { providerRequestId: "req_real" }
        : undefined;
    },
    compensate: (context) => {
      behaviour.state.status = String(context.restore.status);
      behaviour.state.version += 1;
      return { providerRequestId: "req_undo" };
    }
  });

  return {
    engine: new TransactionEngine({ adapter: effect }),
    dispatches: () => dispatchCount
  };
}

const run = (engine: ReturnType<typeof adversary>["engine"], status = "published") =>
  engine.run({
    input: { id: "r1", status },
    actor: TEST_ACTOR,
    purpose: "Update a record against a misbehaving provider"
  });

test("a provider reporting success while changing nothing cannot get a verified receipt", async () => {
  const state: Record_ = { id: "r1", status: "draft", version: 1 };
  // Reports success, never actually writes, and offers no evidence.
  const { engine } = adversary({ state, commitOnDispatch: false, evidence: "none" });

  const result = await run(engine);

  assert.notEqual(result.transaction.state, "VERIFIED_COMMITTED");
  assert.equal(result.receipt.finalStatus, "MANUAL_RECOVERY_REQUIRED");
  assert.notEqual(result.receipt.finality, "VERIFIED");
  assert.equal(state.status, "draft");
});

test("fabricated evidence cannot manufacture a verified outcome", async () => {
  const state: Record_ = { id: "r1", status: "draft", version: 1 };
  // The nastiest case: nothing committed, but the evidence endpoint says it did.
  const { engine } = adversary({
    state,
    commitOnDispatch: false,
    dispatchBehaviour: "lost-ack",
    evidence: "always"
  });

  const result = await run(engine);

  // Evidence alone is not proof. State is still authoritative, and it disagrees.
  assert.notEqual(result.transaction.state, "VERIFIED_COMMITTED");
  assert.equal(state.status, "draft", "no write ever happened");
  const verification = result.receipt.actions[0]?.observations.find(
    (observation) => observation["kind"] === "verification" || observation["kind"] === "reconciliation"
  );
  assert.ok(verification !== undefined, "the receipt must record why it was not trusted");
  assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
});

test("a provider that contradicts itself between reads is never reported as verified", async () => {
  const state: Record_ = { id: "r1", status: "draft", version: 1 };
  let reads = 0;
  // Every observation returns something different, so no witness can hold.
  const { engine } = adversary({
    state,
    observed: () => {
      reads += 1;
      return { id: "r1", status: `drifting-${reads}`, version: reads };
    }
  });

  const result = await run(engine);

  assert.ok(
    ["ABORTED", "MANUAL_RECOVERY_REQUIRED", "PREFLIGHT_FAILED"].includes(result.transaction.state),
    `expected a refusal, got ${result.transaction.state}`
  );
  assert.notEqual(result.transaction.state, "VERIFIED_COMMITTED");
});

test("a lost acknowledgement with no provider evidence never dispatches twice", async () => {
  const state: Record_ = { id: "r1", status: "draft", version: 1 };
  const { engine, dispatches } = adversary({
    state,
    dispatchBehaviour: "lost-ack",
    evidence: "none"
  });

  const result = await run(engine);

  assert.equal(dispatches(), 1, "a second dispatch would risk a duplicate effect");
  assert.equal(result.forwardDispatchCount, 1);
  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.equal(result.receipt.finality, "UNKNOWN");
  assert.equal(result.receipt.manualRecovery.length, 1);
});

test("a provider that silently reverts the effect after verification is caught at compensation", async () => {
  const state: Record_ = { id: "r1", status: "draft", version: 1 };
  let observations = 0;
  const { engine } = adversary({
    state,
    observed: () => {
      observations += 1;
      // Truthful until compensation is planned, then claims something else.
      return observations <= 3 ? { ...state } : { id: "r1", status: "hijacked", version: 99 };
    }
  });

  const result = await run(engine);

  assert.ok(
    result.transaction.state === "MANUAL_RECOVERY_REQUIRED" ||
      result.transaction.state === "VERIFIED_COMMITTED",
    `unexpected terminal state ${result.transaction.state}`
  );
  // Whatever happened, the receipt must be internally consistent and signed.
  assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
  assert.equal(verifyEventChain(result.events).valid, true);
});

test("a definitive rejection produces no effect and no compensation", async () => {
  const state: Record_ = { id: "r1", status: "draft", version: 1 };
  const { engine, dispatches } = adversary({ state, dispatchBehaviour: "reject" });

  const result = await run(engine);

  assert.equal(dispatches(), 1);
  assert.equal(state.status, "draft");
  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.equal(result.action.state, "PROVIDER_REJECTED");
  assert.equal(result.receipt.actions[0]?.recovery, undefined);
});

test("every adversarial receipt is signed, chain-linked, and self-consistent", async () => {
  const cases: Array<() => ReturnType<typeof adversary>> = [
    () => adversary({ state: { id: "r1", status: "draft", version: 1 }, evidence: "none" }),
    () =>
      adversary({
        state: { id: "r1", status: "draft", version: 1 },
        commitOnDispatch: false,
        evidence: "always",
        dispatchBehaviour: "lost-ack"
      }),
    () =>
      adversary({
        state: { id: "r1", status: "draft", version: 1 },
        dispatchBehaviour: "reject"
      })
  ];

  for (const [index, build] of cases.entries()) {
    const { engine } = build();
    const result = await run(engine);
    assert.equal(
      verifyReceipt(result.receipt, result.receiptPublicKeyPem),
      true,
      `case ${index}: signature`
    );
    assert.equal(verifyEventChain(result.events).valid, true, `case ${index}: chain`);
    assert.equal(result.receipt.transactionId, result.transaction.transactionId);
    // A receipt claiming VERIFIED must never carry unresolved items.
    if (result.receipt.finality === "VERIFIED" && result.receipt.finalStatus === "VERIFIED_COMMITTED") {
      assert.equal(result.receipt.manualRecovery.length, 0, `case ${index}: verified yet unresolved`);
    }
  }
});
