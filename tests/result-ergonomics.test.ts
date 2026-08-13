import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderTimeoutAfterDispatchError,
  TransactionEngine,
  ZeroGateError,
  assertCommitted,
  defineEffect
} from "../src/index.js";
import { TEST_ACTOR } from "./helpers/publish-harness.js";

/**
 * What a caller is handed, and whether it can be acted on without digging.
 *
 * Everything here was once only discoverable by walking `action.observations`
 * and casting, or was not discoverable at all.
 */

interface Doc {
  id: string;
  status: string;
  version: number;
}

const CONTRACT = { name: "test.docs.publish", version: "1.0.0" };

function publishEffect(options: {
  store: Doc;
  onDispatch?: (store: Doc) => void;
  evidence?: () => { providerRequestId: string } | undefined | null;
  materialFields?: readonly string[];
}) {
  return defineEffect<{ id: string; status: string }, Doc>({
    operation: "test.docs.publish",
    contract: CONTRACT,
    materialFields: options.materialFields ?? ["status"],
    resourceScope: (input) => [{ type: "document", id: input.id }],
    observe: () => ({ ...options.store }),
    version: (state) => String(state.version),
    expected: (input, before) => ({ ...before, status: input.status }),
    dispatch: () => {
      if (options.onDispatch === undefined) {
        options.store.status = "published";
        options.store.version += 1;
        return;
      }
      options.onDispatch(options.store);
    },
    findEvidence: () => options.evidence?.() ?? undefined,
    compensate: () => {
      options.store.status = "draft";
      options.store.version += 1;
    }
  });
}

const run = (adapter: ReturnType<typeof publishEffect>) =>
  new TransactionEngine({ adapter, receiptSigner: "ephemeral" }).run({
    input: { id: "d1", status: "published" },
    actor: TEST_ACTOR,
    purpose: "Publish a document"
  });

test("a committed run says so in one boolean and one sentence", async () => {
  const store: Doc = { id: "d1", status: "draft", version: 1 };
  const result = await run(publishEffect({ store }));

  assert.equal(result.committed, true);
  assert.equal(result.recovery, undefined);
  assert.equal(result.refusal, undefined);
  assert.match(result.summary, /committed once/);
  assert.match(result.summary, /document:d1/, "the summary must name the resource");
  assert.doesNotThrow(() => assertCommitted(result));
  // dispatch returned nothing at all, which is allowed.
  assert.equal(result.forwardDispatchCount, 1);
});

test("an unresolved outcome hands over a recovery packet, not a haystack", async () => {
  const store: Doc = { id: "d1", status: "draft", version: 1 };
  const result = await run(
    publishEffect({
      store,
      onDispatch: (current) => {
        // The write lands and the acknowledgement is lost.
        current.status = "published";
        current.version += 1;
        throw new ProviderTimeoutAfterDispatchError();
      }
    })
  );

  assert.equal(result.committed, false);
  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.ok(result.recovery !== undefined);
  assert.equal(result.recovery.effectMayHaveCommitted, true);
  assert.equal(
    result.recovery.observedMatchesExpected,
    true,
    "the change is present, and nothing attributes it to this transaction"
  );
  assert.equal(result.recovery.resource, "document:d1");
  assert.equal(result.recovery.logicalOperationId, result.action.logicalOperationId);
  assert.match(
    result.recovery.instruction,
    /Ask the provider/,
    "the instruction must say what to do, not restate the state name"
  );
  assert.throws(() => assertCommitted(result), ZeroGateError);
});

test("a request that never left is distinguished from one that may have landed", async () => {
  const store: Doc = { id: "d1", status: "draft", version: 1 };
  const result = await run(
    publishEffect({
      store,
      onDispatch: () => {
        throw new ProviderTimeoutAfterDispatchError();
      }
    })
  );

  assert.equal(result.recovery?.effectMayHaveCommitted, true);
  assert.equal(
    result.recovery?.observedMatchesExpected,
    false,
    "state does not show the change, which is the fact an operator needs"
  );
});

test("an unclassified throw from dispatch is unknown, never a rejection", async () => {
  const store: Doc = { id: "d1", status: "draft", version: 1 };
  const result = await run(
    publishEffect({
      store,
      onDispatch: (current) => {
        // The write landed. Then our own code threw something unclassified.
        current.status = "published";
        current.version += 1;
        throw new Error("socket hang up");
      }
    })
  );

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.notEqual(
    result.action.state,
    "PROVIDER_REJECTED",
    "an unclassified throw is not evidence that the provider rejected anything"
  );
  assert.equal(
    result.recovery?.effectMayHaveCommitted,
    true,
    "the change is live; claiming nothing committed would be a lie"
  );
  assert.equal(result.reconciliationUsed, true);
  assert.match(
    result.notes.join(" "),
    /did not classify/,
    "the note must teach which error to throw"
  );
  assert.doesNotMatch(result.summary, /nothing committed/);
});

test("an unclassified throw from compensate is unknown, not a failed undo", async () => {
  const store: Doc = { id: "d1", status: "draft", version: 1 };
  const adapter = defineEffect<{ id: string; status: string }, Doc>({
    operation: "test.docs.publish",
    contract: CONTRACT,
    materialFields: ["status"],
    resourceScope: (input) => [{ type: "document", id: input.id }],
    observe: () => ({ ...store }),
    version: (state) => String(state.version),
    expected: (input, before) => ({ ...before, status: input.status }),
    dispatch: () => {
      store.status = "published";
      store.version += 1;
    },
    findEvidence: () => undefined,
    compensate: () => {
      // The undo landed. Then our own code threw something unclassified.
      store.status = "draft";
      store.version += 1;
      throw new Error("socket hang up");
    }
  });

  const result = await new TransactionEngine({ adapter, receiptSigner: "ephemeral" }).run({
    input: { id: "d1", status: "published" },
    actor: TEST_ACTOR,
    purpose: "Publish, then fail downstream",
    finalize: () => {
      throw new Error("downstream failed");
    }
  });

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.equal(result.action.state, "COMPENSATION_FAILED");
  assert.doesNotMatch(
    result.recovery?.instruction ?? "",
    /still in place/,
    "the undo may well have landed; claiming otherwise is a guess"
  );
  assert.match(result.notes.join(" "), /did not classify/);
});

test("a refused run carries the reason, not just the code", async () => {
  const store: Doc = { id: "d1", status: "published", version: 1 };
  const result = await run(publishEffect({ store }));

  assert.equal(result.committed, false);
  assert.equal(result.transaction.state, "PREFLIGHT_FAILED");
  assert.equal(result.refusal?.dispatched, false);
  assert.equal(result.refusal?.code, "UNSUPPORTED");
  assert.match(result.refusal?.message ?? "", /no material effect/);
  assert.match(
    result.notes.join(" "),
    /no material effect/,
    "the note must carry the message the engine already had"
  );
});

test("evidence may be reported as null, the way a lookup usually reports it", async () => {
  const store: Doc = { id: "d1", status: "draft", version: 1 };
  const result = await run(
    publishEffect({
      store,
      evidence: () => null,
      onDispatch: (current) => {
        current.status = "published";
        current.version += 1;
        throw new ProviderTimeoutAfterDispatchError();
      }
    })
  );

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
});

test("a material field that exists nowhere is named, not canonicalised", async () => {
  const store: Doc = { id: "d1", status: "draft", version: 1 };
  const result = await run(publishEffect({ store, materialFields: ["staus"] }));

  assert.equal(result.transaction.state, "PREFLIGHT_FAILED");
  const message = result.refusal?.message ?? "";
  assert.match(message, /'staus'/, "the error must name the field");
  assert.match(message, /Observed fields: id, status, version/, "and what was actually there");
  assert.doesNotMatch(message, /Unsupported value/);
});

test("a field the effect creates is diffed rather than throwing", async () => {
  interface Sparse {
    id: string;
    version: number;
    label?: string;
  }
  const store: Sparse = { id: "s1", version: 1 };
  const adapter = defineEffect<{ id: string; label: string }, Sparse>({
    operation: "test.sparse.label",
    contract: CONTRACT,
    materialFields: ["label"],
    resourceScope: (input) => [{ type: "sparse", id: input.id }],
    observe: () => ({ ...store }),
    version: (state) => String(state.version),
    expected: (input, before) => ({ ...before, label: input.label }),
    dispatch: () => {
      store.label = "first";
      store.version += 1;
    },
    findEvidence: () => undefined,
    compensate: () => undefined
  });

  const result = await new TransactionEngine({ adapter, receiptSigner: "ephemeral" }).run({
    input: { id: "s1", label: "first" },
    actor: TEST_ACTOR,
    purpose: "Set a label that did not exist before"
  });

  assert.equal(result.committed, true, "setting an absent field is an ordinary change");
  assert.deepEqual(result.preview.diff, [{ field: "label", before: null, after: "first" }]);
});

test("an effect that cannot express removal refuses to compensate rather than crash", async () => {
  interface Sparse {
    id: string;
    version: number;
    label?: string;
  }
  const store: Sparse = { id: "s2", version: 1 };
  const adapter = defineEffect<{ id: string; label: string }, Sparse>({
    operation: "test.sparse.label",
    contract: CONTRACT,
    materialFields: ["label"],
    resourceScope: (input) => [{ type: "sparse", id: input.id }],
    observe: () => ({ ...store }),
    version: (state) => String(state.version),
    expected: (input, before) => ({ ...before, label: input.label }),
    dispatch: () => {
      store.label = "first";
      store.version += 1;
    },
    findEvidence: () => undefined,
    compensate: () => undefined
  });

  const result = await new TransactionEngine({ adapter, receiptSigner: "ephemeral" }).run({
    input: { id: "s2", label: "first" },
    actor: TEST_ACTOR,
    purpose: "Set a label, then fail downstream",
    finalize: () => {
      throw new Error("downstream failed");
    }
  });

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.match(result.recovery?.reason ?? "", /did not exist before this effect/);
  assert.match(result.recovery?.reason ?? "", /restore\(\)/);
});

test("receipt key retention is reported rather than assumed", async () => {
  const store: Doc = { id: "d1", status: "draft", version: 1 };
  const result = await run(publishEffect({ store }));
  assert.equal(result.receiptKeyRetention, "ephemeral");
});
