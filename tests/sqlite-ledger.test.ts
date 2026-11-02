import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { SqliteLedger } from "../src/core/sqlite-ledger.js";
import { InMemoryEventLedger, type AppendEventInput } from "../src/core/event-ledger.js";
import { startPublishHarness, PUBLISH_INPUT } from "./helpers/publish-harness.js";

async function location(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "zerogate-sqlite-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "events.sqlite");
}
const input: AppendEventInput = { id: "event1", subject: "tx1", type: "test", data: { value: 1 } };

test("SQLite retains a real engine run and verifies its receipt chain after reopen", async (t) => {
  const path = await location(t);
  const ledger = new SqliteLedger(path);
  const harness = await startPublishHarness({ ledger });
  let result;
  try { result = await harness.run({ input: PUBLISH_INPUT }); }
  finally { await harness.close(); await ledger.close(); }
  assert.equal(result.committed, true);
  assert.equal((await readFile(path)).subarray(0, 16).toString(), "SQLite format 3\u0000");
  const reopened = new SqliteLedger(path);
  try {
    assert.deepEqual(await reopened.list(result.transaction.transactionId), result.events);
    assert.equal(await reopened.verify(), true);
    const memory = new InMemoryEventLedger(result.events);
    assert.equal(await reopened.chainRoot(result.transaction.transactionId), await memory.chainRoot(result.transaction.transactionId));
  } finally { await reopened.close(); }
});

test("SQLite retries remain idempotent after reopen and conflicts roll back", async (t) => {
  const path = await location(t);
  const first = new SqliteLedger(path);
  const event = await first.append(input);
  await first.close();
  const ledger = new SqliteLedger(path);
  try {
    assert.deepEqual(await ledger.append(input), event);
    await assert.rejects(ledger.append({ ...input, data: { value: 2 } }), /different content/);
    await assert.rejects(ledger.append({ ...input, id: "event2", expectedSequence: 5 }), /sequence/);
    assert.equal((await ledger.list()).length, 1);
    assert.equal((await ledger.append({ ...input, id: "event2" })).sequence, 2);
    assert.equal(await ledger.verify(), true);
  } finally { await ledger.close(); }
});

test("SQLite serializes concurrent appends and isolates callers' objects", async (t) => {
  const ledger = new SqliteLedger(await location(t));
  try {
    const owned = { ...input, data: { value: 1 } };
    const pending = ledger.append(owned);
    owned.data.value = 99;
    assert.equal((await pending).data["value"], 1);
    await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.append({ ...input, id: `e${i}`, subject: `s${i % 2}` })));
    assert.equal((await ledger.list("s0")).length, 10);
    assert.equal(await ledger.verify(), true);
    const events = await ledger.list(); events[0]!.data["value"] = 99;
    assert.equal((await ledger.list())[0]!.data["value"], 1);
  } finally { await ledger.close(); }
});

test("SQLite refuses a corrupted retained event chain instead of losing history silently", async (t) => {
  const path = await location(t);
  const ledger = new SqliteLedger(path);
  await ledger.append(input); await ledger.close();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const database = new DatabaseSync(path);
  database.exec(`UPDATE zerogate_events SET event = json_set(event, '$.data.value', 999)`);
  database.close();
  assert.throws(() => new SqliteLedger(path), /invalid event chain/);
});
