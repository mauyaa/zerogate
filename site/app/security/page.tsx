import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow, GITHUB_URL, PageShell } from "../../components/site-shell";

export const metadata: Metadata = {
  title: "Security",
  description:
    "ZeroGate's threat model, the guarantees it enforces cryptographically, and how to report a vulnerability.",
};

const properties = [
  {
    title: "Approvals cannot be replayed or retargeted",
    body: "A mandate is signed over the transaction ID, action-set root, payload hash, contract digest, witness hash, limits hash, and policy version, and it is single-use. Changing any bound value invalidates it; presenting it twice is rejected.",
  },
  {
    title: "Evidence is append-only and hash-linked",
    body: "Each ledger event carries the hash of its predecessor. Removing, reordering, or editing an event breaks the chain, and the receipt commits to the chain root — so a tampered history cannot carry a valid receipt.",
  },
  {
    title: "Receipts are verifiable offline",
    body: "Ed25519 over a canonical body. Verification requires only the receipt, the events, and a public key, so an auditor never has to trust the runtime that produced them.",
  },
  {
    title: "Secrets are kept out of evidence",
    body: "Fields declared as redacted are hashed rather than recorded, and a secret-shaped-value check guards against accidental inclusion. Provider results are returned to the caller but never placed in a receipt.",
  },
  {
    title: "Canonicalisation is strict",
    body: "RFC 8785 JCS with negative zero, cycles, lone surrogates, and non-plain objects rejected outright. Two payloads that mean the same thing hash the same; two that differ cannot be made to collide by formatting.",
  },
];

const nonGuarantees = [
  "ZeroGate does not authenticate your provider calls or manage credentials. That is your client's job.",
  "It does not defend against a provider that lies about its own operation records. Reconciliation is only as trustworthy as the evidence endpoint.",
  "It does not prevent a caller with the signing key from producing receipts for events that never happened. Protect the key.",
  "It does not sandbox effect definitions. A definition you install runs with your process's authority.",
];

export default function SecurityPage() {
  return (
    <PageShell>
      <section className="container container--prose page-head">
        <Eyebrow>Security</Eyebrow>
        <h1 style={{ fontSize: "var(--text-4xl)" }}>Security</h1>
        <p className="lede">
          ZeroGate exists to make side effects accountable, so the properties below are enforced in
          code and covered by tests — not asserted in prose.
        </p>
      </section>

      <section className="container container--prose prose" style={{ paddingBottom: "var(--space-24)" }}>
        <h2>What is enforced</h2>
        {properties.map((property) => (
          <section key={property.title}>
            <h3>{property.title}</h3>
            <p>{property.body}</p>
          </section>
        ))}

        <h2>What is not a guarantee</h2>
        <ul>
          {nonGuarantees.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>
          The <Link href="/docs/limits">limits page</Link> covers the functional boundaries alongside
          these.
        </p>

        <h2>Reporting a vulnerability</h2>
        <p>
          Report privately through GitHub&apos;s security advisory flow on the{" "}
          <a href={`${GITHUB_URL}/security/advisories/new`} rel="noreferrer noopener" target="_blank">
            repository
          </a>
          . Please include a reproduction and the commit you tested. Do not open a public issue for a
          vulnerability.
        </p>
        <p>
          Expect an acknowledgement within a few days. This is a small project maintained by one
          person, and that is the honest expectation to set — there is no paid support tier and no
          guaranteed response window.
        </p>

        <h2>Dependencies</h2>
        <p>
          The published package has <strong>zero runtime dependencies</strong>. PostgreSQL support is
          an optional peer dependency on <code>pg</code>, used only if you construct a{" "}
          <code>PostgresEventLedger</code>. Cryptography comes from Node&apos;s built-in{" "}
          <code>node:crypto</code>; no third-party crypto is bundled.
        </p>
      </section>
    </PageShell>
  );
}
