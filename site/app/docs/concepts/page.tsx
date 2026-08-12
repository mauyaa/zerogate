import type { Metadata } from "next";
import Link from "next/link";
import { DocPage } from "../../../components/docs-shell";

export const metadata: Metadata = {
  title: "Concepts",
  description: "The six terms ZeroGate uses, and why each one exists.",
};

const terms = [
  {
    term: "Witness",
    definition:
      "Authoritative provider state observed while building the preview, plus a version marker. Approval is bound to it, and it is re-checked immediately before dispatch. If it moved, the approved preview no longer describes reality and nothing is sent.",
  },
  {
    term: "Material field",
    definition:
      "A field this effect claims ownership of. Only material fields are diffed, verified, and restored. Everything else on the record is none of the effect's business — which is what makes compensation safe to reason about.",
  },
  {
    term: "Logical operation ID",
    definition:
      "A stable identifier for one intended dispatch. It goes to the provider as an idempotency key or client reference so that afterwards you can ask whether that exact attempt committed. Without it, reconciliation is guesswork.",
  },
  {
    term: "Outcome unknown",
    definition:
      "The request left the process and no answer arrived. Not a failure and not a success. This is the state that ordinary retry logic collapses into 'failed', and collapsing it is the bug ZeroGate exists to prevent.",
  },
  {
    term: "Reconciliation",
    definition:
      "Asking the provider what committed, keyed by the logical operation ID. It resolves an unknown outcome without a second dispatch. When the provider cannot answer, reconciliation fails honestly rather than inferring from state.",
  },
  {
    term: "Finality",
    definition:
      "How strongly the outcome is known: VERIFIED when authoritative state confirms it, PROVIDER_ATTESTED when only the provider's record does, UNKNOWN when nothing does, DISPUTED when evidence disagrees. Receipts carry it so downstream systems can act on the difference.",
  },
];

export default function ConceptsPage() {
  return (
    <DocPage
      current="/docs/concepts"
      title="Concepts"
      lead="Six terms. Learn these and the rest of the documentation reads itself."
    >
      <dl>
        {terms.map(({ term, definition }) => (
          <div key={term} style={{ marginBottom: "var(--space-8)" }}>
            <dt>
              <h2 style={{ fontSize: "var(--text-xl)", marginTop: 0 }}>{term}</h2>
            </dt>
            <dd style={{ margin: "var(--space-3) 0 0" }}>
              <p>{definition}</p>
            </dd>
          </div>
        ))}
      </dl>

      <h2>The distinction everything rests on</h2>
      <p>
        A provider&apos;s success response is <strong>evidence</strong>. Authoritative state is{" "}
        <strong>proof</strong>. ZeroGate never treats the first as the second: after every dispatch it
        re-reads state and compares it to the approved postcondition. That is why a provider that
        answers <code>200 OK</code> while quietly doing something else produces a failed
        verification rather than a false success.
      </p>
      <p>
        The same distinction governs undoing. Compensation checks that the record still matches what
        this effect produced. If a human edited it in between, the effect no longer owns that state,
        and ZeroGate refuses to overwrite it — reporting{" "}
        <code>COMPENSATION_BLOCKED</code> instead. See the{" "}
        <Link href="/docs/state-model">state model</Link>.
      </p>
    </DocPage>
  );
}
