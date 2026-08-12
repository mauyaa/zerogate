import type { Metadata } from "next";
import Link from "next/link";
import { DocPage, docsPages } from "../../components/docs-shell";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "How ZeroGate previews, admits, reconciles, verifies, and signs one provider side effect.",
};

export default function DocsIndexPage() {
  return (
    <DocPage
      current="/docs"
      title="Documentation"
      lead="ZeroGate turns one provider mutation into a transaction you can prove happened — or prove did not."
    >
      <p>
        Most retry logic is a coin flip dressed up as a policy. A write leaves your process, the
        connection dies, and the code has to decide between doing it twice and not doing it at all.
        ZeroGate replaces that decision with a question it can actually answer:{" "}
        <strong>what does the provider say committed?</strong>
      </p>

      <h2>The shape of it</h2>
      <p>
        You describe one operation — how to read its state, what change you intend, how to dispatch
        it, and how to ask the provider whether a given dispatch landed. ZeroGate owns everything
        else: canonical payload hashing, single-use approval bound to that exact payload, a freshness
        re-check immediately before dispatch, reconciliation instead of retry, verification against
        authoritative state, compensation that refuses when unsafe, and a signed receipt.
      </p>
      <p>
        The division matters. Nothing in your effect definition decides when to retry or when undoing
        is safe, so those rules are implemented once and tested once.
      </p>

      <h2>Where to go next</h2>
      <ul>
        {docsPages
          .filter((page) => page.href !== "/docs")
          .map((page) => (
            <li key={page.href}>
              <Link href={page.href}>{page.title}</Link> — {page.blurb}
            </li>
          ))}
      </ul>

      <h2>Scope</h2>
      <p>
        One action per transaction. The default event ledger is in-memory; PostgreSQL and SQLite
        ledgers are provided for durability. Approvals are payload-bound tokens, not a human
        approval service — wiring them to a real approver is your responsibility. The{" "}
        <Link href="/docs/limits">limits page</Link> lists every boundary without softening any of
        them.
      </p>
    </DocPage>
  );
}
