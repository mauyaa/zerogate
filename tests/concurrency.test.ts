import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryEventLedger,
  TransactionEngine,
  ZeroGateError,
  defineEffect,
  verifyEventChain,
  verifyReceipt
} from "../src/index.js";
import { TEST_ACTOR } from "./helpers/publish-harness.js";

/**
 * Contention and volume.
 *
 * The invariant under load is arithmetic: the number of writes the provider
 * actually performed must equal the number of transactions that claimed
 * VERIFIED_COMMITTED. Any gap either way is a duplicate effect or a false claim.
 *
 * The provider yields to the event loop at every await point, so transactions
 * genuinely interleave rather than running to completion one at a time.
 */

interface Row {
  id: string;
  status: string;
  version: number;
}

/** A provider with an atomic compare-and-set, which is what real ones give you. */
function createStore() {
  const rows = new Map<string, Row>();
  const operations = new Map<string, string>();
  let writes = 0;

  const yieldPoint = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  return {
    writes: () => writes,
    seed(id: string): void {
      rows.set(id, { id, status: "draft", version: 1 });
    },
    read: (id: string): Row | undefined => {
      const row = rows.get(id);
      return row === undefined ? undefined : { ...row };
    },
    async observe(id: string): Promise<Row> {
      await yieldPoint();
      const row = rows.get(id);
      if (row === undefined) throw new ZeroGateError("PROVIDER_REJECTED", "missing row", false);
      return { ...row };
    },
    async patch(input: {
      id: string;
      status: string;
      expectedVersion: number;
      operationId: string;
    }): Promise<string> {
      await yieldPoint();
      const existing = operations.get(input.operationId);
      if (existing !== undefined) return existing;
      const row = rows.get(input.id);
      if (row === undefined) throw new ZeroGateError("PROVIDER_REJECTED", "missing row", false);
      // Atomic compare-and-set: the loser of a race is rejected, not overwritten.
      if (row.version !== input.expectedVersion) {
        throw new ZeroGateError("STALE_WITNESS", "version moved before the write", false);
      }
      await yieldPoint();
      row.status = input.status;
      row.version += 1;
      writes += 1;
      const requestId = `req_${writes}`;
      operations.set(input.operationId, requestId);
      return requestId;
    },
    findEvidence: (operationId: string): string | undefined => operations.get(operationId)
  };
}

function buildEngine(store: ReturnType<typeof createStore>, ledger?: InMemoryEventLedger) {
  const effect = defineEffect<{ id: string; status: string }, Row>({
    operation: "load.rows.update",
    contract: { name: "load", version: "1.0.0" },
    materialFields: ["status"],
    resourceScope: (input) => [{ type: "row", id: input.id }],
    observe: (input) => store.observe(input.id),
    version: (state) => String(state.version),
    expected: (input, before) => ({ ...before, status: input.status }),
    dispatch: async (context) => ({
      providerRequestId: await store.patch({
        id: context.input.id,
        status: context.input.status,
        expectedVersion: context.before.version,
        operationId: context.logicalOperationId
      })
    }),
    findEvidence: (context) => {
      const requestId = store.findEvidence(context.logicalOperationId);
      return requestId === undefined ? undefined : { providerRequestId: requestId };
    }
  });
  return new TransactionEngine({
    adapter: effect,
    ...(ledger === undefined ? {} : { ledger })
  });
}

async function settle<T>(work: Array<Promise<T>>): Promise<{
  fulfilled: T[];
  rejected: unknown[];
}> {
  const settled = await Promise.allSettled(work);
  return {
    fulfilled: settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
    // `reason` is typed `any` by the standard library; keep it as `unknown`.
    rejected: settled.flatMap((r): unknown[] => (r.status === "rejected" ? [r.reason as unknown] : []))
  };
}

test("32 transactions racing for one row never write twice for one transaction", async () => {
  const store = createStore();
  store.seed("row");
  const engine = buildEngine(store);

  // Each transaction sets a *different* value on the same field, so they are
  // semantically in conflict. Under last-writer-wins that is expected to leave
  // most of them unable to see their own postcondition afterwards, and the
  // honest report for those is not success.
  const { fulfilled, rejected } = await settle(
    Array.from({ length: 32 }, (_, index) =>
      engine.run({
        input: { id: "row", status: `status-${index}` },
        actor: TEST_ACTOR,
        purpose: `Concurrent update ${index}`
      })
    )
  );

  // Anything that threw must be a typed contention error, never a crash.
  for (const reason of rejected) {
    assert.ok(reason instanceof ZeroGateError, `unexpected throw: ${String(reason)}`);
  }

  // The invariant that actually matters: one transaction, at most one write.
  for (const result of fulfilled) {
    assert.ok(
      result.forwardDispatchCount <= 1,
      `a transaction dispatched ${result.forwardDispatchCount} times`
    );
  }
  const dispatches = fulfilled.reduce((total, r) => total + r.forwardDispatchCount, 0);
  assert.equal(
    store.writes(),
    dispatches,
    `provider wrote ${store.writes()} times for ${dispatches} dispatches — a duplicate effect`
  );

  // Nobody may claim success while holding unresolved work.
  const committed = fulfilled.filter((r) => r.transaction.state === "VERIFIED_COMMITTED");
  for (const result of committed) {
    assert.equal(result.receipt.finality, "VERIFIED");
    assert.equal(result.receipt.manualRecovery.length, 0);
  }

  // Everyone else refused, and said so, rather than overwriting or pretending.
  for (const result of fulfilled) {
    if (result.transaction.state === "VERIFIED_COMMITTED") continue;
    assert.ok(
      ["ABORTED", "MANUAL_RECOVERY_REQUIRED", "PREFLIGHT_FAILED"].includes(result.transaction.state),
      `loser reached ${result.transaction.state}`
    );
    assert.notEqual(result.receipt.finalStatus, "VERIFIED_COMMITTED");
  }

  // Every receipt, winner or loser, is signed and chain-linked.
  for (const result of fulfilled) {
    assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
    assert.equal(verifyEventChain(result.events).valid, true);
  }
});

test("32 transactions racing to set the same value all agree on the outcome", async () => {
  const store = createStore();
  store.seed("row");
  const engine = buildEngine(store);

  // Same target value, so contention does not make anyone's postcondition false.
  // Whoever dispatches should be able to verify, because the end state matches
  // regardless of which transaction produced it.
  const { fulfilled, rejected } = await settle(
    Array.from({ length: 32 }, (_, index) =>
      engine.run({
        input: { id: "row", status: "published" },
        actor: TEST_ACTOR,
        purpose: `Convergent update ${index}`
      })
    )
  );

  for (const reason of rejected) {
    assert.ok(reason instanceof ZeroGateError, `unexpected throw: ${String(reason)}`);
  }

  const dispatches = fulfilled.reduce((total, r) => total + r.forwardDispatchCount, 0);
  assert.equal(store.writes(), dispatches, "one write per dispatch, no duplicates");
  assert.equal(store.read("row")?.status, "published");

  // No transaction may report failure of an effect that demonstrably holds, nor
  // success of one that does not. Every fulfilled run is internally consistent.
  for (const result of fulfilled) {
    assert.ok(result.forwardDispatchCount <= 1);
    if (result.receipt.finalStatus === "VERIFIED_COMMITTED") {
      assert.equal(result.receipt.finality, "VERIFIED");
      assert.equal(result.receipt.manualRecovery.length, 0);
    }
    assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
  }
  assert.ok(
    fulfilled.some((r) => r.transaction.state === "VERIFIED_COMMITTED"),
    "convergent contention should still let transactions succeed"
  );
});

test("200 independent transactions all commit exactly once each", async () => {
  const store = createStore();
  const ledger = new InMemoryEventLedger();
  const engine = buildEngine(store, ledger);
  const count = 200;
  for (let index = 0; index < count; index += 1) store.seed(`row-${index}`);

  const { fulfilled, rejected } = await settle(
    Array.from({ length: count }, (_, index) =>
      engine.run({
        input: { id: `row-${index}`, status: "published" },
        actor: TEST_ACTOR,
        purpose: "Volume update"
      })
    )
  );

  assert.deepEqual(rejected, []);
  assert.equal(fulfilled.length, count);
  assert.equal(
    fulfilled.every((r) => r.transaction.state === "VERIFIED_COMMITTED"),
    true
  );
  assert.equal(store.writes(), count, "exactly one provider write per transaction");
  assert.equal(
    fulfilled.every((r) => r.forwardDispatchCount === 1),
    true
  );

  // Ledger integrity across every interleaved transaction.
  assert.equal(await ledger.verify(), true);
  const all = await ledger.list();
  assert.equal(verifyEventChain(all).valid, true);

  // Event count per transaction is bounded, so nothing grows without limit.
  const perTransaction = new Map<string, number>();
  for (const event of all) {
    perTransaction.set(event.subject, (perTransaction.get(event.subject) ?? 0) + 1);
  }
  assert.equal(perTransaction.size, count);
  const counts = [...perTransaction.values()];
  assert.equal(
    counts.every((n) => n === counts[0]),
    true,
    `event counts differ across identical transactions: ${[...new Set(counts)].join(", ")}`
  );
});

test("interleaved transactions keep independent, gap-free event sequences", async () => {
  const store = createStore();
  const ledger = new InMemoryEventLedger();
  const engine = buildEngine(store, ledger);
  for (let index = 0; index < 12; index += 1) store.seed(`row-${index}`);

  const { fulfilled } = await settle(
    Array.from({ length: 12 }, (_, index) =>
      engine.run({
        input: { id: `row-${index}`, status: "published" },
        actor: TEST_ACTOR,
        purpose: "Interleaved update"
      })
    )
  );

  for (const result of fulfilled) {
    const events = await ledger.list(result.transaction.transactionId);
    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: events.length }, (_, index) => index + 1),
      "sequences must be contiguous per transaction despite interleaving"
    );
    const receiptIndex = events.findIndex(
      (event) => event.type === "dev.zerogate.receipt.issued.v1"
    );
    assert.equal(
      verifyEventChain(events.slice(0, receiptIndex)).root,
      result.receipt.integrity.eventChainRoot
    );
  }
});
