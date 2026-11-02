import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReceiptSigner, SqliteLedger, TransactionEngine, assertCommitted } from "../../src/index.js";
import { createPublishEffect } from "./effect.js";
import { DocumentService } from "./service.js";

// An actual HTTP write whose response is deliberately lost. All artifacts stay
// in the ignored scratch directory; the SQLite ledger survives this process.
const output = ".scratch/example";
await mkdir(output, { recursive: true });
const signer = new ReceiptSigner();
const ledger = new SqliteLedger(join(output, "events.sqlite"));
const service = new DocumentService();
service.seed({ id: "release", title: "Release notes", status: "draft", tags: [] });
try {
  const baseUrl = await service.listen();
  service.setFault("lost-ack-after-commit");
  const engine = new TransactionEngine({ adapter: createPublishEffect(baseUrl), ledger, receiptSigner: signer });
  const result = await engine.run({
    input: { documentId: "release", status: "published", tags: ["shipped"] },
    actor: { principalId: "developer", agentId: "example", agentVersion: "1.0.0" },
    purpose: "Verify a real write despite a lost HTTP response"
  });
  assertCommitted(result);
  assert.equal(service.read("release")?.status, "published");
  assert.equal(service.mutationCount, 1);
  assert.equal(result.reconciliationUsed, true);
  await writeFile(join(output, "receipt.json"), JSON.stringify(result.receipt, null, 2));
  await writeFile(join(output, "events.json"), JSON.stringify(result.events, null, 2));
  await writeFile(join(output, "public-key.pem"), result.receiptPublicKeyPem);
  process.stdout.write(JSON.stringify({
    committed: result.committed, summary: result.summary,
    providerWrites: service.mutationCount, reconciled: result.reconciliationUsed,
    artifacts: output
  }, null, 2) + "\n");
} finally {
  await service.close();
  await ledger.close();
}
const reopened = new SqliteLedger(join(output, "events.sqlite"));
try { assert.equal(await reopened.verify(), true); }
finally { await reopened.close(); }
