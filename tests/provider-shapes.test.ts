import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderTimeoutAfterDispatchError,
  TransactionEngine,
  defineEffect,
  verifyReceipt
} from "../src/index.js";
import { TEST_ACTOR } from "./helpers/publish-harness.js";

/**
 * A provider shaped as the opposite of the worked example.
 *
 * The example is a mutable record with a conditional write and an operation
 * lookup keyed by idempotency key. This one is an append-only ledger: there is
 * no conditional write, nothing can be updated in place, and evidence is only
 * discoverable by *searching* the entries for a reference. Compensation is a
 * reversing entry rather than a restored field.
 *
 * If the adapter contract is genuinely general, the same engine handles both
 * without changes. That is what this file is for.
 */

interface Entry {
  reference: string;
  kind: "post" | "reversal";
  amountCents: number;
}

interface AccountState {
  /** Derived, not stored: the engine compares this like any other field. */
  balanceCents: number;
  entryCount: number;
}

function createAppendOnlyLedger() {
  const entries: Entry[] = [];
  let appends = 0;

  const balance = (): number =>
    entries.reduce((total, entry) => total + (entry.kind === "reversal" ? -entry.amountCents : entry.amountCents), 0);

  return {
    appends: () => appends,
    entries: () => [...entries],
    state: (): AccountState => ({ balanceCents: balance(), entryCount: entries.length }),
    /** No update, no delete, no compare-and-set. Appending is the only verb. */
    append(entry: Entry): string {
      // Append-only providers are naturally idempotent on a client reference.
      const existing = entries.find((candidate) => candidate.reference === entry.reference);
      if (existing !== undefined) return `dup_${entry.reference}`;
      entries.push(entry);
      appends += 1;
      return `entry_${appends}`;
    },
    /** Evidence is not keyed: it has to be searched for. */
    search(reference: string): Entry | undefined {
      return entries.find((entry) => entry.reference === reference);
    }
  };
}

function buildEngine(ledgerStore: ReturnType<typeof createAppendOnlyLedger>, options: { lostAck?: boolean } = {}) {
  const effect = defineEffect<{ amountCents: number }, AccountState>({
    operation: "accounting.entry.post",
    contract: { name: "append-only", version: "1.0.0" },
    materialFields: ["balanceCents"],
    residualRisk: [
      "The provider offers no conditional write, so freshness is rechecked immediately before dispatch rather than enforced atomically."
    ],
    witnessStrength: "weak",
    resourceScope: () => [{ type: "account", id: "acct_1" }],
    observe: () => ledgerStore.state(),
    // No version field exists; the entry count is the only monotonic marker.
    version: (state) => String(state.entryCount),
    expected: (input, before) => ({
      balanceCents: before.balanceCents + input.amountCents,
      entryCount: before.entryCount + 1
    }),
    dispatch: (context) => {
      const requestId = ledgerStore.append({
        reference: context.logicalOperationId,
        kind: "post",
        amountCents: context.input.amountCents
      });
      if (options.lostAck === true) {
        throw new ProviderTimeoutAfterDispatchError("posted, then the connection died");
      }
      return { providerRequestId: requestId };
    },
    findEvidence: (context) => {
      const found = ledgerStore.search(context.logicalOperationId);
      return found === undefined ? undefined : { providerRequestId: `found_${found.reference}` };
    },
    // Compensation cannot restore a field here; it posts a reversing entry.
    compensate: (context) => ({
      providerRequestId: ledgerStore.append({
        reference: context.logicalOperationId,
        kind: "reversal",
        amountCents: context.expected.balanceCents - context.before.balanceCents
      })
    })
  });

  return new TransactionEngine({ adapter: effect });
}

test("an append-only provider with no conditional write commits and verifies", async () => {
  const store = createAppendOnlyLedger();
  const engine = buildEngine(store);

  const result = await engine.run({
    input: { amountCents: 2500 },
    actor: TEST_ACTOR,
    purpose: "Post an accounting entry"
  });

  assert.equal(result.transaction.state, "VERIFIED_COMMITTED");
  assert.equal(result.receipt.finality, "VERIFIED");
  assert.equal(store.appends(), 1);
  assert.equal(store.state().balanceCents, 2500);
  assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
  // The residual risk the definition declares is carried into the receipt.
  assert.match(String(result.receipt.actions[0]?.residualRisk[0]), /no conditional write/);
});

test("a lost acknowledgement is resolved by searching for the reference, not by a key lookup", async () => {
  const store = createAppendOnlyLedger();
  const engine = buildEngine(store, { lostAck: true });

  const result = await engine.run({
    input: { amountCents: 1000 },
    actor: TEST_ACTOR,
    purpose: "Post an entry whose acknowledgement is lost"
  });

  assert.equal(result.transaction.state, "VERIFIED_COMMITTED");
  assert.equal(result.reconciliationUsed, true);
  assert.equal(result.forwardDispatchCount, 1);
  assert.equal(store.appends(), 1, "the entry must be posted exactly once");
  assert.equal(store.state().balanceCents, 1000);
});

test("compensation posts a reversing entry instead of restoring a field", async () => {
  const store = createAppendOnlyLedger();
  const engine = buildEngine(store);

  const result = await engine.run({
    input: { amountCents: 4200 },
    actor: TEST_ACTOR,
    purpose: "Post an entry that downstream work then rejects",
    finalize: () => {
      throw new Error("the period is closed");
    }
  });

  assert.equal(result.transaction.state, "VERIFIED_COMPENSATED");
  assert.equal(store.appends(), 2, "one posting plus one reversal");
  assert.deepEqual(
    store.entries().map((entry) => entry.kind),
    ["post", "reversal"]
  );
  // Append-only means the history is intact and the net effect is zero.
  assert.equal(store.state().balanceCents, 0);
  assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
});

test("a weak witness is recorded as weak rather than overstated", async () => {
  const store = createAppendOnlyLedger();
  const engine = buildEngine(store);

  const result = await engine.run({
    input: { amountCents: 100 },
    actor: TEST_ACTOR,
    purpose: "Post an entry against a provider with a weak freshness guarantee"
  });

  assert.equal(result.preview.witness.strength, "weak");
  const preflight = result.receipt.actions[0]?.observations.find(
    (observation) => observation["kind"] === "preflight"
  );
  const witness = preflight?.["witness"] as { strength?: string } | undefined;
  assert.equal(witness?.strength, "weak", "the receipt must not claim a stronger witness than exists");
});
