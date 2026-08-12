import type { Metadata } from "next";
import { CodePanel } from "../../../components/code-panel";
import { Callout, DocPage } from "../../../components/docs-shell";

export const metadata: Metadata = {
  title: "Receipts",
  description:
    "How to verify a ZeroGate receipt without trusting the process that produced it.",
};

const VERIFY_CLI = `npx zerogate receipt verify receipt.json events.json signing-key.pub.pem

{
  "ok": true,
  "transactionId": "8f1c...",
  "finalStatus": "VERIFIED_COMMITTED",
  "finality": "VERIFIED",
  "signatureValid": true,
  "coveredEventChainValid": true,
  "fullEventChainValid": true,
  "rootMatches": true,
  "receiptEventMatches": true,
  "coveredEvents": 17
}`;

const VERIFY_LIB = `import { verifyReceipt, verifyEventChain } from "zerogate";

// 1. The signature covers the body, the key ID, and the chain root.
verifyReceipt(receipt, publicKeyPem);            // true

// 2. The events the receipt commits to actually hash into that root.
const covered = events.slice(0, receiptEventIndex);
verifyEventChain(covered).root === receipt.integrity.eventChainRoot;`;

const keys = [
  ["Generate a keypair", "npx zerogate keys new --out .zerogate/keys"],
];

export default function ReceiptsPage() {
  return (
    <DocPage
      current="/docs/receipts"
      title="Receipts"
      lead="A receipt is only worth something if someone who distrusts your process can check it. That is the design constraint."
    >
      <p>
        Every terminal outcome produces a receipt: an Ed25519 signature over a canonical body, bound
        to the root of a hash-linked chain of the events that led there. Verification needs the
        receipt, the events, and a public key — no ZeroGate runtime, no database, no network.
      </p>

      <h2>What the signature covers</h2>
      <ul>
        <li>
          <strong>The intent binding</strong> — tenant, environment, actor, purpose, resource scope,
          expiry, limits hash, action-set root, and policy version.
        </li>
        <li>
          <strong>The action</strong> — operation, logical operation ID, payload hash, contract
          digest, terminal status, finality, attempt IDs, and provider request IDs.
        </li>
        <li>
          <strong>The observations</strong> — the preview diff, dispatch evidence, reconciliation
          result, verification result, and recovery plan, in order.
        </li>
        <li>
          <strong>The chain root</strong> — so the receipt cannot be moved onto a different history.
        </li>
        <li>
          <strong>Residual risk</strong> — what remains untrue even on the success path.
        </li>
      </ul>

      <h2>Verifying from the command line</h2>
      <CodePanel filename="terminal" code={VERIFY_CLI} plain />
      <p>
        The command exits non-zero if any check fails, so it drops straight into CI or an audit job.
      </p>

      <h2>Verifying in code</h2>
      <CodePanel filename="verify.ts" code={VERIFY_LIB} />

      <Callout title="Both checks are required.">
        <p>
          A valid signature alone only proves the body was signed by that key. Re-deriving the chain
          root is what proves the receipt describes the history it claims to describe. Checking one
          without the other leaves a gap.
        </p>
      </Callout>

      <h2>Signing keys</h2>
      <p>
        The engine generates an ephemeral keypair by default, which is correct for tests and useless
        for audit — nobody can check a receipt signed by a key that no longer exists. For anything
        durable, generate a keypair, keep the private half out of version control, and publish only
        the <code>.pub.pem</code>.
      </p>
      {keys.map(([label, command]) => (
        <CodePanel key={label} filename="terminal" code={command} plain />
      ))}
      <p>
        Then pass a <code>ReceiptSigner</code> built from that key when constructing the engine, so
        every receipt is verifiable against a key you actually retain.
      </p>

      <h2>Redaction</h2>
      <p>
        Fields listed in <code>redactFields</code> appear in the receipt as{" "}
        <code>beforeHash</code> and <code>afterHash</code> rather than values. The diff stays
        verifiable — anyone holding the original content can confirm the hashes — without the receipt
        itself carrying the content.
      </p>
    </DocPage>
  );
}
