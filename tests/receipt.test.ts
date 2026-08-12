import assert from "node:assert/strict";
import test from "node:test";
import { verifyEventChain } from "../src/core/event-ledger.js";
import { ReceiptSigner, verifyReceipt } from "../src/core/receipt.js";
import { PUBLISH_INPUT, startPublishHarness } from "./helpers/publish-harness.js";

test("receipt signature binds the body, signing key, and covered event-chain root", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const result = await harness.run({ input: PUBLISH_INPUT });
  assert.equal(result.transaction.state, "VERIFIED_COMMITTED");
  assert.equal(verifyReceipt(result.receipt, result.receiptPublicKeyPem), true);

  const receiptEventIndex = result.events.findIndex(
    (event) => event.type === "dev.zerogate.receipt.issued.v1"
  );
  assert.ok(receiptEventIndex > 0);
  const coveredChain = verifyEventChain(result.events.slice(0, receiptEventIndex));
  assert.equal(coveredChain.valid, true);
  assert.equal(coveredChain.root, result.receipt.integrity.eventChainRoot);

  const rootTamper = structuredClone(result.receipt);
  rootTamper.integrity.eventChainRoot = "0".repeat(64);
  assert.equal(verifyReceipt(rootTamper, result.receiptPublicKeyPem), false);

  const keyIdTamper = structuredClone(result.receipt);
  keyIdTamper.integrity.keyId = "ed25519:wrong";
  assert.equal(verifyReceipt(keyIdTamper, result.receiptPublicKeyPem), false);

  const bodyTamper = structuredClone(result.receipt);
  bodyTamper.finalStatus = "ABORTED";
  assert.equal(verifyReceipt(bodyTamper, result.receiptPublicKeyPem), false);

  const otherSigner = new ReceiptSigner();
  assert.equal(verifyReceipt(result.receipt, otherSigner.publicKeyPem()), false);
  assert.equal(verifyReceipt(result.receipt, "not a public key"), false);
});
