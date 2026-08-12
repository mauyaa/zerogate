import type { Metadata } from "next";
import { Eyebrow, PageShell } from "../../components/site-shell";

export const metadata: Metadata = {
  title: "Privacy",
  description: "This site has no database, no analytics, no cookies, and no forms.",
};

export default function PrivacyPage() {
  return (
    <PageShell>
      <section className="container container--prose page-head">
        <Eyebrow>Privacy</Eyebrow>
        <h1 style={{ fontSize: "var(--text-4xl)" }}>Privacy</h1>
        <p className="lede">
          This site collects nothing. That is a design decision, not an oversight, and it is short
          enough to state completely.
        </p>
      </section>

      <section
        className="container container--prose prose"
        style={{ paddingBottom: "var(--space-24)" }}
      >
        <h2>What this site does not do</h2>
        <ul>
          <li>No cookies are set, and no local storage is written.</li>
          <li>No analytics, tag managers, session recording, or fingerprinting.</li>
          <li>No forms, no sign-up, no waitlist, and no account of any kind.</li>
          <li>No third-party scripts, embeds, or trackers. Every asset is served from this origin.</li>
          <li>No database. There is nowhere for personal data to be stored.</li>
        </ul>

        <h2>What the host necessarily sees</h2>
        <p>
          Pages are served by Vercel, which processes standard request data — IP address, user agent,
          and requested path — in order to deliver the page and to defend against abuse. That is
          ordinary web-server operation and is described in Vercel&apos;s own privacy documentation.
          No such data is collected or retained by this project.
        </p>

        <h2>The library</h2>
        <p>
          The <code>zerogate</code> npm package sends no telemetry. It makes exactly the provider
          calls your own effect definition makes, and nothing else. It writes evidence only to the
          ledger you configure.
        </p>
        <p>
          Receipts are worth a note: they record payload hashes, contract digests, and material-field
          diffs. If a field holds personal data, declare it in <code>redactFields</code> so it is
          hashed into the receipt instead of recorded. Where those receipts are stored, and for how
          long, is entirely under your control.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this page belong in a GitHub issue. Vulnerability reports do not — see the
          security page.
        </p>
      </section>
    </PageShell>
  );
}
