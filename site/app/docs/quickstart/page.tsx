import type { Metadata } from "next";
import Link from "next/link";
import { CodePanel } from "../../../components/code-panel";
import { Callout, DocPage } from "../../../components/docs-shell";

export const metadata: Metadata = {
  title: "Quickstart",
  description: "Install ZeroGate, define one effect, and resolve a dropped write correctly.",
};

const INSTALL = `npm install zerogate`;

const DEFINE = `import { defineEffect, ProviderTimeoutAfterDispatchError } from "zerogate";
import contract from "./publish.effect.json" with { type: "json" };

export const publishDocument = defineEffect({
  operation: "docs.publish",
  contract,                              // its digest is recorded in every receipt
  materialFields: ["status", "tags"],    // the only fields this effect owns

  resourceScope: (input) => [{ type: "document", id: input.documentId }],

  // Read authoritative state. Must not mutate anything.
  observe: (input) => api.getDocument(input.documentId),

  // A version marker for the freshness witness: an ETag, updated_at, anything.
  version: (state) => state.version + ":" + state.updatedAt,

  // The state this effect should produce.
  expected: (input, before) => ({ ...before, status: input.status, tags: input.tags }),

  async dispatch({ input, before, logicalOperationId }) {
    try {
      const response = await api.patchDocument(input.documentId, {
        idempotencyKey: logicalOperationId,
        ifMatch: before.version,
        body: { status: input.status, tags: input.tags }
      });
      return { providerRequestId: response.requestId };
    } catch (cause) {
      // The one rule that matters: when you do not know, say so.
      throw new ProviderTimeoutAfterDispatchError();
    }
  },

  // "Did my dispatch commit?" — answered by the provider, not guessed from state.
  findEvidence: ({ logicalOperationId }) => api.findOperation(logicalOperationId),

  // Omit this to make the effect non-compensatable. It will never be auto-undone.
  compensate: ({ input, restore, logicalOperationId }) =>
    api.patchDocument(input.documentId, {
      idempotencyKey: logicalOperationId,
      body: restore
    })
});`;

const RUN = `import { TransactionEngine } from "zerogate";
import { publishDocument } from "./publish-document.js";

const engine = new TransactionEngine({ adapter: publishDocument });

const result = await engine.run({
  input: { documentId: "doc_42", status: "published", tags: ["release"] },
  actor: { principalId: "u_1", agentId: "release-agent", agentVersion: "1.0.0" },
  purpose: "Publish the release notes",

  // Downstream work. If it throws, the publish is compensated — unless doing so
  // would overwrite something this transaction does not own.
  finalize: () => notifySubscribers()
});

console.log(result.transaction.state);       // VERIFIED_COMMITTED
console.log(result.forwardDispatchCount);    // 1, even if the answer was lost
console.log(result.receipt.finality);        // VERIFIED`;

const VERIFY = `npx zerogate receipt verify receipt.json events.json signing-key.pub.pem`;

export default function QuickstartPage() {
  return (
    <DocPage
      current="/docs/quickstart"
      title="Quickstart"
      lead="Install the package, describe one operation, and run it. Node 22 or newer; no other runtime dependencies."
    >
      <h2>1. Install</h2>
      <CodePanel filename="terminal" code={INSTALL} plain />

      <h2>2. Describe one operation</h2>
      <p>
        An effect definition answers provider questions only. Read the comments closely — the two
        that carry the whole guarantee are <code>dispatch</code> and <code>findEvidence</code>.
      </p>
      <CodePanel filename="publish-document.ts" code={DEFINE} />

      <Callout title="Never guess in dispatch.">
        <p>
          If a request left your process and you did not get an answer, throw{" "}
          <code>ProviderTimeoutAfterDispatchError</code>. That is the signal that makes ZeroGate
          reconcile instead of retry. Reporting a failure you have not confirmed is how duplicate
          effects happen.
        </p>
      </Callout>

      <h2>3. Run it</h2>
      <CodePanel filename="publish-release.ts" code={RUN} />
      <p>
        Every run ends in a terminal state with a signed receipt — including the unhappy ones. See
        the <Link href="/docs/state-model">state model</Link> for what each ending means and how it
        is reached.
      </p>

      <h2>4. Verify the receipt</h2>
      <p>
        A receipt is only worth something if someone who does not trust your process can check it.
        The CLI reads the files and re-derives every claim; it needs no ZeroGate runtime and no
        network access.
      </p>
      <CodePanel filename="terminal" code={VERIFY} plain />

      <h2>What your provider has to support</h2>
      <p>
        <code>findEvidence</code> is the load-bearing requirement. It must answer{" "}
        <strong>&quot;did operation X commit?&quot;</strong> from the provider&apos;s own records —
        an idempotency key it can look up, a client reference it stores and returns, or an audit
        trail you can search. Inferring it from current state is not sufficient, because anything
        else could have produced that state.
      </p>
      <p>
        If your provider offers none of these, ZeroGate will still refuse to retry blindly — it will
        report <code>MANUAL_RECOVERY_REQUIRED</code> with the reason, which is the honest answer.
      </p>

      <h2>Durable ledgers</h2>
      <p>
        The default ledger is in-memory, which is fine for tests and for work that does not need to
        survive a restart. For anything else, use{" "}
        <code>PostgresEventLedger</code> from <code>zerogate/postgres</code> or the exported{" "}
        <code>SqliteLedger</code>.
      </p>
    </DocPage>
  );
}
