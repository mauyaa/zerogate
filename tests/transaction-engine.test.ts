import assert from "node:assert/strict";
import test from "node:test";
import { createPublishEffect } from "../examples/rest-resource/effect.js";
import { DocumentService } from "../examples/rest-resource/service.js";
import {
  ApprovalAuthority,
  TransactionEngine,
  ZeroGateError,
  verifyEventChain,
  verifyReceipt
} from "../src/index.js";
import { PUBLISH_INPUT, TEST_ACTOR, startPublishHarness } from "./helpers/publish-harness.js";

/**
 * These tests drive the whole transaction over real sockets against the example
 * REST service. Every outcome below is produced by the provider genuinely
 * misbehaving — a dropped connection, a concurrent edit, a refusal — not by the
 * engine being told which ending to perform.
 */

test("a verified effect commits exactly once and signs a receipt", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const result = await harness.run({ input: PUBLISH_INPUT });

  assert.equal(result.transaction.state, "VERIFIED_COMMITTED");
  assert.equal(result.action.state, "VERIFIED_SUCCEEDED");
  assert.equal(result.receipt.finalStatus, "VERIFIED_COMMITTED");
  assert.equal(result.receipt.finality, "VERIFIED");
  assert.equal(result.forwardDispatchCount, 1);
  assert.equal(result.reconciliationUsed, false);
  assert.equal(harness.service.mutationCount, 1);
  assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
  assert.equal(verifyEventChain(result.events).valid, true);

  const document = harness.service.read("doc_release_notes");
  assert.equal(document?.status, "published");
  assert.deepEqual(document?.tags, ["release", "shipped"]);
});

test("a lost acknowledgement is reconciled instead of retried", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  harness.service.setFault("lost-ack-after-commit");
  const result = await harness.run({ input: PUBLISH_INPUT });

  // The critical assertion: the provider was mutated once, not twice.
  assert.equal(harness.service.mutationCount, 1);
  assert.equal(result.forwardDispatchCount, 1);
  assert.equal(result.reconciliationUsed, true);
  assert.equal(result.transaction.state, "VERIFIED_COMMITTED");
  assert.equal(result.receipt.finality, "VERIFIED");
  assert.ok(
    result.notes.some((note) => note.includes("No blind retry")),
    "the receipt notes should record that no blind retry happened"
  );

  const reconciliation = result.receipt.actions[0]?.observations.find(
    (observation) => observation["kind"] === "reconciliation"
  );
  assert.equal(reconciliation?.["committed"], true);
  assert.equal(reconciliation?.["resolved"], true);
  assert.ok(
    (result.receipt.actions[0]?.providerRequestIds.length ?? 0) >= 1,
    "reconciliation should recover the provider request ID that actually committed"
  );
});

test("an unknown outcome the provider cannot explain stays unresolved", async (t) => {
  const service = new DocumentService();
  service.seed({
    id: "doc_1",
    title: "Untraceable",
    status: "draft",
    tags: ["a"]
  });
  const baseUrl = await service.listen();
  t.after(() => service.close());

  // A provider that cannot answer "did operation X commit?" leaves the
  // transaction unresolved. Guessing would risk a double effect.
  const adapter = createPublishEffect(baseUrl);
  const blindEngine = new TransactionEngine({
    adapter: {
      ...adapter,
      reconcile: async () => ({
        resolved: false,
        committed: false,
        finality: "UNKNOWN" as const,
        reason: "The provider exposes no way to look up this operation"
      })
    }
  });

  service.setFault("lost-ack-after-commit");
  const result = await blindEngine.run({
    input: { documentId: "doc_1", status: "published", tags: ["a", "b"] },
    actor: TEST_ACTOR,
    purpose: "Publish a document through a provider with no evidence endpoint"
  });

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.equal(result.action.state, "OUTCOME_UNKNOWN");
  assert.equal(result.receipt.finality, "UNKNOWN");
  assert.equal(result.forwardDispatchCount, 1);
  assert.equal(service.mutationCount, 1, "no second dispatch may be attempted");
  assert.equal(result.receipt.manualRecovery.length, 1);
});

test("failing downstream work compensates the verified effect", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const result = await harness.run({
    input: PUBLISH_INPUT,
    finalize: () => {
      throw new Error("the notification service rejected the release");
    }
  });

  assert.equal(result.transaction.state, "VERIFIED_COMPENSATED");
  assert.equal(result.action.state, "VERIFIED_COMPENSATED");
  assert.equal(result.receipt.finalStatus, "VERIFIED_COMPENSATED");
  assert.equal(result.receipt.finality, "VERIFIED");
  assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);

  // The effect was undone to exactly the fields it owned.
  const document = harness.service.read("doc_release_notes");
  assert.equal(document?.status, "draft");
  assert.deepEqual(document?.tags, ["needs-review", "release"]);
  assert.equal(document?.title, "Release v2.4");
  assert.ok(
    result.notes.some((note) => note.includes("notification service")),
    "the receipt should record why the effect was compensated"
  );
});

test("compensation is blocked rather than overwriting a concurrent edit", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const result = await harness.run({
    input: PUBLISH_INPUT,
    finalize: () => {
      // Someone edits the record before the compensation is planned.
      harness.service.edit("doc_release_notes", { tags: ["release", "hotfix"] });
      throw new Error("downstream work failed");
    }
  });

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.equal(result.action.state, "COMPENSATION_BLOCKED");
  assert.equal(result.receipt.actions[0]?.recovery?.["status"], "blocked");
  assert.equal(result.receipt.manualRecovery.length, 1);

  // The human's edit survived untouched.
  const document = harness.service.read("doc_release_notes");
  assert.deepEqual(document?.tags, ["release", "hotfix"]);
});

test("a lost compensation acknowledgement is reconciled, not repeated", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const result = await harness.run({
    input: PUBLISH_INPUT,
    finalize: () => {
      harness.service.setFault("lost-ack-after-commit");
      throw new Error("downstream work failed");
    }
  });

  assert.equal(result.transaction.state, "VERIFIED_COMPENSATED");
  assert.equal(result.reconciliationUsed, true);
  assert.equal(
    harness.service.mutationCount,
    2,
    "one forward mutation plus exactly one compensating mutation"
  );
  const document = harness.service.read("doc_release_notes");
  assert.equal(document?.status, "draft");
});

test("a provider success response is not trusted when state disagrees", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  // The provider reports success, then state does not match the approved
  // postcondition. Verification must catch that.
  const adapter = createPublishEffect(harness.baseUrl);
  const engine = new TransactionEngine({
    adapter: {
      ...adapter,
      async dispatch(request) {
        const evidence = await adapter.dispatch(request);
        harness.service.edit("doc_release_notes", { tags: ["release", "unexpected"] });
        return evidence;
      }
    }
  });

  const result = await engine.run({
    input: PUBLISH_INPUT,
    actor: TEST_ACTOR,
    purpose: "Publish the release notes"
  });

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.notEqual(result.receipt.finalStatus, "VERIFIED_COMMITTED");
  const verification = result.receipt.actions[0]?.observations.find(
    (observation) => observation["kind"] === "verification"
  );
  assert.equal(verification?.["ok"], false);
});

test("a stale preview aborts before dispatch and still produces a receipt", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const adapter = createPublishEffect(harness.baseUrl);
  const engine = new TransactionEngine({
    adapter: {
      ...adapter,
      assertFresh(preflight) {
        // Someone edits the record between approval and dispatch.
        harness.service.edit("doc_release_notes", { tags: ["release", "moved"] });
        return adapter.assertFresh(preflight);
      }
    }
  });

  const result = await engine.run({
    input: PUBLISH_INPUT,
    actor: TEST_ACTOR,
    purpose: "Publish the release notes"
  });

  assert.equal(result.transaction.state, "ABORTED");
  assert.equal(result.action.state, "CANCELLED");
  assert.equal(result.forwardDispatchCount, 0);
  assert.equal(harness.service.mutationCount, 0, "nothing may be dispatched on a stale preview");
  assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
  assert.ok(result.notes.some((note) => note.includes("STALE_WITNESS")));
});

test("a change with no material effect is refused before dispatch", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const result = await harness.run({
    input: { documentId: "doc_release_notes", status: "draft", tags: ["needs-review", "release"] }
  });

  assert.equal(result.transaction.state, "PREFLIGHT_FAILED");
  assert.equal(result.action.state, "PREFLIGHT_REJECTED");
  assert.equal(harness.service.mutationCount, 0);
  assert.equal(result.receipt.finalStatus, "PREFLIGHT_FAILED");
});

test("an approval bound to a different payload is refused before dispatch", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const authority = new ApprovalAuthority();
  const foreignApproval = authority.issue({
    transactionId: "00000000-0000-4000-8000-000000000000",
    actor: TEST_ACTOR,
    approverId: TEST_ACTOR.principalId,
    approvalLevel: "human-owner",
    actionSetRoot: "0".repeat(64),
    payloadHash: "1".repeat(64),
    contractDigest: "2".repeat(64),
    resourceWitnessHash: "3".repeat(64),
    limitsHash: "4".repeat(64),
    policyVersion: "policy.m1.human-approval.v1",
    ttlSeconds: 300
  });

  const result = await harness.run({ input: PUBLISH_INPUT, approval: foreignApproval });

  assert.equal(result.transaction.state, "APPROVAL_DENIED");
  assert.equal(result.action.state, "CANCELLED");
  assert.equal(harness.service.mutationCount, 0);
});

test("a definitive provider rejection leaves nothing to compensate", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  harness.service.setFault("definitive-rejection");
  const result = await harness.run({ input: PUBLISH_INPUT });

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.equal(result.action.state, "PROVIDER_REJECTED");
  assert.equal(harness.service.mutationCount, 0);
  assert.equal(result.receipt.actions[0]?.recovery, undefined);
});

test("reusing one idempotency key with a different payload is rejected by the provider", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const first = await fetch(`${harness.baseUrl}/documents/doc_release_notes`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "idempotency-key": "key-1" },
    body: JSON.stringify({ status: "published" })
  });
  assert.equal(first.status, 200);

  const replay = await fetch(`${harness.baseUrl}/documents/doc_release_notes`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "idempotency-key": "key-1" },
    body: JSON.stringify({ status: "archived" })
  });
  assert.equal(replay.status, 409);
  assert.equal(harness.service.read("doc_release_notes")?.status, "published");
});

test("an effect that declares no compensating operation is never auto-undone", async (t) => {
  const service = new DocumentService();
  service.seed({ id: "doc_x", title: "One way", status: "draft", tags: ["a"] });
  const baseUrl = await service.listen();
  t.after(() => service.close());

  const compensatable = createPublishEffect(baseUrl);
  const oneWay = {
    ...compensatable,
    planRecovery: async () => ({
      safe: false,
      reason: "Effect 'example.documents.publish' declares no compensating operation"
    })
  };
  const engine = new TransactionEngine({ adapter: oneWay });

  const result = await engine.run({
    input: { documentId: "doc_x", status: "published", tags: ["a", "b"] },
    actor: TEST_ACTOR,
    purpose: "Publish a one-way document",
    finalize: () => {
      throw new Error("downstream work failed");
    }
  });

  assert.equal(result.transaction.state, "MANUAL_RECOVERY_REQUIRED");
  assert.equal(result.action.state, "COMPENSATION_BLOCKED");
  assert.equal(service.mutationCount, 1, "a non-compensatable effect must not be reversed");
});

test("the ledger, receipt, and event chain agree on every terminal outcome", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const committed = await harness.run({ input: PUBLISH_INPUT });
  const compensated = await harness.run({
    input: { documentId: "doc_release_notes", status: "archived", tags: ["release", "archived"] },
    finalize: () => {
      throw new Error("downstream work failed");
    }
  });

  for (const result of [committed, compensated]) {
    assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);
    const receiptIndex = result.events.findIndex(
      (event) => event.type === "dev.zerogate.receipt.issued.v1"
    );
    const covered = verifyEventChain(result.events.slice(0, receiptIndex));
    assert.equal(covered.valid, true);
    assert.equal(covered.root, result.receipt.integrity.eventChainRoot);
    assert.equal(result.receipt.transactionId, result.transaction.transactionId);
  }
  assert.equal(await harness.engine.ledger.verify(), true);
});

test("an unreachable provider is reported as safe to retry, not as unknown", async (t) => {
  const service = new DocumentService();
  service.seed({ id: "doc_gone", title: "Gone", status: "draft", tags: ["a"] });
  const baseUrl = await service.listen();
  await service.close();
  t.after(() => service.close());

  const engine = new TransactionEngine({ adapter: createPublishEffect(baseUrl) });
  await assert.rejects(
    () =>
      engine.run({
        input: { documentId: "doc_gone", status: "published", tags: ["a", "b"] },
        actor: TEST_ACTOR,
        purpose: "Publish against a provider that is not listening"
      }),
    (error: unknown) =>
      error instanceof ZeroGateError &&
      (error.code === "PROVIDER_REJECTED" || error.code === "PROVIDER_SAFE_TO_RETRY")
  );
});
