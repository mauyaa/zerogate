import type { Metadata } from "next";
import Link from "next/link";
import { DocPage } from "../../../components/docs-shell";

export const metadata: Metadata = {
  title: "Limits",
  description:
    "Everything ZeroGate does not do, stated plainly enough to decide against it.",
};

const limits = [
  {
    title: "It is not exactly-once delivery",
    body: "Nothing can provide that across a network, and any library claiming it is lying to you. ZeroGate provides at most one verified effect per approved payload, plus an honest report when it cannot determine what happened. The unresolved case is a real outcome you have to handle, not an edge case.",
  },
  {
    title: "Reconciliation depends entirely on your provider",
    body: "If the provider cannot answer whether a specific operation committed, a lost acknowledgement is genuinely unresolvable. ZeroGate will refuse to retry and report MANUAL_RECOVERY_REQUIRED. It does not infer commitment from state matching the expectation, because anything else could have produced that state.",
  },
  {
    title: "Compensation is a forward write, not a rollback",
    body: "There is no transaction to abort at the provider. Compensation issues a second conditional write, and it is refused whenever a material field no longer matches what the forward effect produced. An effect that declares no compensate function is never auto-undone at all.",
  },
  {
    title: "One action per transaction",
    body: "Multi-action transactions, dependency ordering, and partial-commit release conditions are modelled in the state machine but not implemented in the engine. If you need two effects to succeed or fail together, ZeroGate does not do that yet.",
  },
  {
    title: "Approvals are tokens, not an approval service",
    body: "ApprovalAuthority issues and consumes single-use, payload-bound mandates. It does not ask a human anything. Connecting it to a real approver, with a real interface and a real audit trail, is your responsibility. By default the engine self-issues an approval, which is appropriate for tests and for callers that gathered consent out of band.",
  },
  {
    title: "The freshness check is not atomic",
    body: "State is re-read immediately before dispatch, which narrows the window between approval and mutation but does not close it. Where the provider supports a conditional write — an ETag, an If-Match, a version precondition — use it in dispatch, and the provider closes the window properly.",
  },
  {
    title: "The default ledger does not survive a restart",
    body: "InMemoryEventLedger is the default. PostgresEventLedger and SqliteLedger are provided for durability, but the engine does not resume an interrupted transaction from a ledger on startup. A process killed mid-transaction leaves a durable event history and no automatic continuation.",
  },
  {
    title: "Receipts signed with an ephemeral key prove nothing later",
    body: "If you do not supply a ReceiptSigner, the engine generates a keypair that dies with the process. The receipt is internally consistent and permanently unverifiable. Supply a retained key for anything you intend to audit.",
  },
];

export default function LimitsPage() {
  return (
    <DocPage
      current="/docs/limits"
      title="Limits"
      lead="A safety library that oversells itself is worse than none, because you will trust it in exactly the moment it fails you."
    >
      <p>
        This page exists so you can decide against ZeroGate on accurate information. Nothing below is
        softened, and none of it is a roadmap promise.
      </p>

      {limits.map((limit) => (
        <section key={limit.title}>
          <h2>{limit.title}</h2>
          <p>{limit.body}</p>
        </section>
      ))}

      <h2>What is actually verified</h2>
      <p>
        The repository&apos;s test suite runs the whole engine against a real HTTP service over real
        sockets — connections dropped after the write commits, concurrent edits arriving between
        verification and compensation, providers that cannot explain what happened, and idempotency
        keys replayed with a different payload. Those paths are covered by tests, not by assertion on
        this page.
      </p>
      <p>
        What is not covered: sustained production load, adversarial providers, clock skew across
        distributed signers, and every provider API that is not the one in the examples. Read the{" "}
        <Link href="/docs/state-model">state model</Link> before depending on any specific ending.
      </p>
    </DocPage>
  );
}
