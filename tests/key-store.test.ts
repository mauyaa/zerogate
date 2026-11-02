import test from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { KeyStore } from "../src/core/key-store.js";
import { ApprovalAuthority } from "../src/core/approval.js";
import { ReceiptSigner } from "../src/core/receipt.js";

test("KeyStore generates and derives deterministic keypairs", () => {
  const store = new KeyStore();
  const pair = store.getOrCreateKeyPair("test-key");

  assert.ok(pair.keyId.startsWith("ed25519:"));
  assert.ok(pair.privateKeyPem.includes("BEGIN PRIVATE KEY"));
  assert.ok(pair.publicKeyPem.includes("BEGIN PUBLIC KEY"));

  const authority = ApprovalAuthority.fromPem(pair.privateKeyPem);
  assert.equal(authority.keyId, pair.keyId);

  const signer = ReceiptSigner.fromPem(pair.privateKeyPem);
  assert.equal(signer.keyId, pair.keyId);
});

test("retained signing keys are owner-only and survive reopening", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zerogate-key-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new KeyStore(directory).getOrCreateKeyPair("retained");
  assert.equal(new KeyStore(directory).getOrCreateKeyPair("retained").keyId, first.keyId);
  if (process.platform !== "win32") assert.equal(statSync(join(directory, "retained.pem")).mode & 0o777, 0o600);
});
