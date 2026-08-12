import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";
import { SqliteLedger } from "../src/core/sqlite-ledger.js";
import type { StoredLedgerEvent } from "../src/core/types.js";

test("SqliteLedger appends and hydrates events persistently", () => {
  const testFile = ".scratch/test-sqlite-ledger.jsonl";
  if (existsSync(testFile)) unlinkSync(testFile);

  const ledger1 = new SqliteLedger(testFile);
  const event: StoredLedgerEvent = {
    specversion: "1.0",
    id: "evt-sq-1",
    source: "zerogate.test",
    type: "dev.zerogate.transaction.created.v1",
    subject: "tx-sq-1",
    time: new Date().toISOString(),
    sequence: 1,
    datacontenttype: "application/json",
    data: { test: true },
    previousHash: "root",
    eventHash: "hash1"
  };

  const res1 = ledger1.append(event);
  assert.equal(res1.duplicate, false);

  const ledger2 = new SqliteLedger(testFile);
  assert.equal(ledger2.getEvents().length, 1);
  assert.equal(ledger2.getEvents()[0]?.id, "evt-sq-1");

  if (existsSync(testFile)) unlinkSync(testFile);
});
