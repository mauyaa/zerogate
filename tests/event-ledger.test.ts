import assert from "node:assert/strict";
import test from "node:test";
import { ZeroGateError } from "../src/core/errors.js";
import {
  InMemoryEventLedger,
  verifyEventChain,
  type AppendEventInput,
  type EventLedger
} from "../src/core/event-ledger.js";
import { verifyReceipt } from "../src/core/receipt.js";
import type { StoredLedgerEvent } from "../src/core/types.js";
import { PUBLISH_INPUT, startPublishHarness } from "./helpers/publish-harness.js";

test("event append is idempotent for the same ID and rejects changed content", async () => {
  const ledger = new InMemoryEventLedger();
  const input: AppendEventInput = {
    id: "event-1",
    type: "dev.zerogate.test.recorded.v1",
    subject: "tx-a",
    data: { value: 1 }
  };
  const first = await ledger.append(input);
  const retry = await ledger.append(input);
  assert.deepEqual(retry, first);
  assert.equal((await ledger.list()).length, 1);
  await assert.rejects(
    () => ledger.append({ ...input, data: { value: 2 } }),
    (error: unknown) => error instanceof ZeroGateError && error.code === "LEDGER_CONFLICT"
  );
});

test("event timestamps are strict RFC 3339 values canonicalized to UTC milliseconds", async () => {
  const ledger = new InMemoryEventLedger();
  const event = await ledger.append({
    type: "dev.zerogate.test.timestamp.v1",
    subject: "tx-time",
    time: "2035-01-02T03:04:05.123456+05:30",
    data: { valid: true }
  });
  assert.equal(event.time, "2035-01-01T21:34:05.123Z");
  assert.equal(await ledger.verify(), true);

  await assert.rejects(
    () =>
      ledger.append({
        type: "dev.zerogate.test.timestamp.v1",
        subject: "tx-time",
        time: "2035-02-30T03:04:05Z",
        data: { valid: false }
      }),
    (error: unknown) => error instanceof ZeroGateError && error.code === "UNSUPPORTED"
  );
});

test("ledger owns an immutable copy of caller data", async () => {
  const ledger = new InMemoryEventLedger();
  const data = { nested: { value: "original" } };
  await ledger.append({
    id: "event-clone",
    type: "dev.zerogate.test.recorded.v1",
    subject: "tx-clone",
    data
  });
  data.nested.value = "mutated";
  const [stored] = await ledger.list("tx-clone");
  assert.equal(stored?.data["nested"] && typeof stored.data["nested"] === "object"
    ? (stored.data["nested"] as { value: string }).value
    : undefined, "original");
  assert.equal(await ledger.verify(), true);
});

test("interleaved subjects keep independent sequences and receipt roots", async () => {
  const ledger = new InMemoryEventLedger();
  await ledger.append({ type: "dev.zerogate.test.recorded.v1", subject: "A", data: { n: 1 } });
  await ledger.append({ type: "dev.zerogate.test.recorded.v1", subject: "B", data: { n: 1 } });
  await ledger.append({ type: "dev.zerogate.test.recorded.v1", subject: "A", data: { n: 2 } });
  assert.deepEqual((await ledger.list("A")).map((event) => event.sequence), [1, 2]);
  assert.deepEqual((await ledger.list("B")).map((event) => event.sequence), [1]);
  assert.equal(verifyEventChain(await ledger.list("A")).root, await ledger.chainRoot("A"));
  assert.equal(verifyEventChain(await ledger.list("B")).root, await ledger.chainRoot("B"));
  assert.equal(await ledger.verify(), true);

  const harness = await startPublishHarness();
  const engine = harness.engine;
  try {
    const first = await harness.run({ input: PUBLISH_INPUT });
    harness.service.setFault("lost-ack-after-commit");
    const second = await harness.run({
      input: { ...PUBLISH_INPUT, tags: ["release", "archived-copy"] }
    });
    for (const result of [first, second]) {
      const subjectEvents = await engine.ledger.list(result.transaction.transactionId);
      const receiptIndex = subjectEvents.findIndex(
        (event: StoredLedgerEvent) => event.type === "dev.zerogate.receipt.issued.v1"
      );
      const covered = verifyEventChain(subjectEvents.slice(0, receiptIndex));
      assert.equal(covered.root, result.receipt.integrity.eventChainRoot);
      assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
    }
    assert.equal(await engine.ledger.verify(), true);
  } finally {
    await harness.close();
  }
});

class AcknowledgementLossLedger implements EventLedger {
  public readonly tenantId = undefined;
  readonly #inner = new InMemoryEventLedger();
  #lost = false;

  public async append(input: AppendEventInput): Promise<StoredLedgerEvent> {
    const event = await this.#inner.append(input);
    if (!this.#lost) {
      this.#lost = true;
      throw new ZeroGateError("LEDGER_CONFLICT", "Simulated lost append acknowledgement", true);
    }
    return event;
  }

  public list(subject?: string): Promise<StoredLedgerEvent[]> {
    return this.#inner.list(subject);
  }

  public chainRoot(subject?: string): Promise<string> {
    return this.#inner.chainRoot(subject);
  }

  public verify(): Promise<boolean> {
    return this.#inner.verify();
  }
}

test("engine retries a lost ledger acknowledgement without duplicating the event", async (t) => {
  const ledger = new AcknowledgementLossLedger();
  const harness = await startPublishHarness({ ledger });
  t.after(() => harness.close());

  const result = await harness.run({ input: PUBLISH_INPUT });
  const ids = result.events.map((event: StoredLedgerEvent) => event.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(await ledger.verify(), true);
});
