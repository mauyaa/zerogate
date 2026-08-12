import assert from "node:assert/strict";
import test from "node:test";
import { createPublishEffect } from "../examples/rest-resource/effect.js";
import { DocumentService } from "../examples/rest-resource/service.js";
import {
  TransactionEngine,
  ZeroGateError,
  defineEffect,
  replayProjection,
  verifyEventChain
} from "../src/index.js";
import { PUBLISH_INPUT, TEST_ACTOR, startPublishHarness } from "./helpers/publish-harness.js";

interface Secretish {
  id: string;
  note: string;
  version: number;
}

function credentialEffect(store: Secretish, options: { redact?: boolean } = {}) {
  return defineEffect<{ id: string; note: string }, Secretish>({
    operation: "test.notes.update",
    contract: { name: "test.notes.update", version: "1.0.0" },
    materialFields: ["note"],
    ...(options.redact === true ? { redactFields: ["note"] } : {}),
    resourceScope: (input) => [{ type: "test.note", id: input.id }],
    observe: () => ({ ...store }),
    version: (state) => String(state.version),
    expected: (input, before) => ({ ...before, note: input.note }),
    dispatch: () => {
      store.note = "dispatched";
      store.version += 1;
      return { providerRequestId: "req_1" };
    },
    findEvidence: () => ({ providerRequestId: "req_1" })
  });
}

test("a credential in a recorded field is refused before anything is dispatched", async () => {
  const store: Secretish = { id: "n1", note: "harmless", version: 1 };
  const engine = new TransactionEngine({ adapter: credentialEffect(store) });

  await assert.rejects(
    () =>
      engine.run({
        input: { id: "n1", note: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" },
        actor: TEST_ACTOR,
        purpose: "Store a note that happens to contain a credential"
      }),
    (error: unknown) =>
      error instanceof ZeroGateError &&
      error.code === "UNSUPPORTED" &&
      error.message.includes("GitHub token") &&
      error.message.includes("redactFields")
  );

  assert.equal(store.note, "harmless", "nothing may be dispatched when evidence is unsafe");
  assert.equal(store.version, 1);
});

test("the same field passes once it is declared redacted", async () => {
  const store: Secretish = { id: "n1", note: "harmless", version: 1 };
  const engine = new TransactionEngine({ adapter: credentialEffect(store, { redact: true }) });

  const result = await engine.run({
    input: { id: "n1", note: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" },
    actor: TEST_ACTOR,
    purpose: "Store a redacted note"
  });

  const diff = result.preview.diff[0];
  assert.equal(diff?.["redacted"], true);
  assert.equal(diff?.["before"], undefined, "a redacted field must not carry its value");
  assert.equal(diff?.["after"], undefined);
  const afterHash = diff?.["afterHash"];
  assert.equal(typeof afterHash, "string");
  assert.match(afterHash as string, /^sha256:[0-9a-f]{64}$/);

  // The whole receipt must be free of the credential.
  assert.doesNotMatch(JSON.stringify(result.receipt), /ghp_[A-Za-z0-9]{16,}/);
});

test("ordinary prose that merely mentions passwords is not blocked", async () => {
  const service = new DocumentService();
  service.seed({ id: "doc_1", title: "Password reset", status: "draft", tags: ["security"] });
  const baseUrl = await service.listen();
  try {
    const engine = new TransactionEngine({ adapter: createPublishEffect(baseUrl) });
    const result = await engine.run({
      input: { documentId: "doc_1", status: "published", tags: ["secret-handling", "security"] },
      actor: TEST_ACTOR,
      purpose: "Publish a document about password resets"
    });
    assert.equal(result.transaction.state, "VERIFIED_COMMITTED");
  } finally {
    await service.close();
  }
});

test("a ledger history replays to the same terminal state the receipt reports", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const result = await harness.run({ input: PUBLISH_INPUT });
  const projection = replayProjection(result.events);

  assert.equal(projection.transactionState, result.transaction.state);
  assert.equal(projection.actionState, result.action.state);
  assert.ok(projection.transactionTransitions.length > 0);
  assert.equal(projection.transactionTransitions.at(-1), "VERIFIED_COMMITTED");
});

test("replaying a tampered history is refused rather than reported", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const result = await harness.run({ input: PUBLISH_INPUT });
  const tampered = structuredClone(result.events);
  // Drop one event from the middle: the chain no longer links.
  tampered.splice(3, 1);

  assert.equal(verifyEventChain(tampered).valid, false);
  assert.throws(
    () => replayProjection(tampered),
    (error: unknown) =>
      error instanceof ZeroGateError && error.code === "LEDGER_INTEGRITY_FAILED"
  );
});
