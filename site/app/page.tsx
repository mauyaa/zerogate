import Link from "next/link";
import { CodePanel } from "../components/code-panel";
import { CheckIcon, Eyebrow, GITHUB_URL, PageShell } from "../components/site-shell";

const HERO_CODE = `const result = await engine.run({
  input:    { documentId: "doc_42", status: "published" },
  purpose:  "Publish the release notes",
  finalize: notifySubscribers
});

// The connection dropped mid-write. It resolved correctly anyway.
result.transaction.state       // VERIFIED_COMMITTED
result.forwardDispatchCount    // 1
result.reconciliationUsed      // true`;

const trustPoints = [
  "One dispatch, even when the answer never arrives",
  "Verified against authoritative state, not the response body",
  "Receipts a third party can check offline",
];

const steps = [
  {
    index: "01",
    title: "Preview",
    body: "Read authoritative state, compute exactly which fields will change, and hash the payload.",
  },
  {
    index: "02",
    title: "Admit",
    body: "Bind single-use approval to that exact payload, contract, and observed state. Re-check freshness immediately before dispatch.",
  },
  {
    index: "03",
    title: "Reconcile",
    body: "If the acknowledgement is lost, ask the provider what committed. Never dispatch again to find out.",
  },
  {
    index: "04",
    title: "Verify and sign",
    body: "Compare authoritative state to the approved postcondition, then sign the event chain.",
  },
];

const outcomes = [
  ["VERIFIED_COMMITTED", "It happened, once, and state proves it."],
  ["VERIFIED_COMPENSATED", "It happened and was undone. State proves both."],
  ["MANUAL_RECOVERY_REQUIRED", "Genuinely unresolved. The receipt says exactly what is unknown."],
  ["ABORTED", "State moved after approval. Nothing was dispatched."],
  ["PREFLIGHT_FAILED", "No material change, or a precondition failed."],
  ["APPROVAL_DENIED", "The approval did not match the payload. Nothing was dispatched."],
];

const limits = [
  {
    title: "This is not exactly-once delivery",
    body: "No library can provide that across a network. ZeroGate provides at most one verified effect per approved payload, and tells you plainly when it cannot determine what happened.",
  },
  {
    title: "Reconciliation is only as good as your provider",
    body: "If a provider cannot answer whether a given operation committed, a lost acknowledgement is genuinely unresolvable. ZeroGate stops and says so.",
  },
  {
    title: "Compensation is not a rollback",
    body: "It is a second, forward, conditional write. It is refused whenever the record no longer matches what your effect produced.",
  },
  {
    title: "One action per transaction",
    body: "Multi-action transactions are not implemented. Approvals are payload-bound tokens, not a human approval service.",
  },
];

export default function HomePage() {
  return (
    <PageShell>
      <section className="hero">
        <div className="container hero-inner">
          <span className="pill">Open source under Apache 2.0</span>
          <h1>Stop guessing whether your request went through.</h1>
          <p className="lede">
            When a provider stops answering mid-write, ZeroGate finds out what actually landed,
            verifies it against authoritative state, and signs a receipt — without dispatching a
            second time to find out.
          </p>
          <div className="button-row">
            <Link className="button button--primary" href="/docs/quickstart">
              Get started
            </Link>
            <a
              className="button button--secondary"
              href={GITHUB_URL}
              rel="noreferrer noopener"
              target="_blank"
            >
              View source <span aria-hidden="true">↗</span>
            </a>
          </div>
          <ul className="trust-strip">
            {trustPoints.map((point) => (
              <li key={point}>
                <CheckIcon />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="container">
        <CodePanel filename="publish-release.ts" label="zerogate" code={HERO_CODE} />
      </section>

      <section className="section" aria-labelledby="the-problem">
        <div className="container">
          <div className="section-head">
            <Eyebrow>The problem</Eyebrow>
            <h2 id="the-problem">A lost answer is not a failure. Treating it as one is the bug.</h2>
            <p>
              When a write leaves your process and nothing comes back, both obvious moves are
              wrong. Retry, and you may do it twice. Give up, and it may already be done. The
              request needs a third option: find out.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">After a dropped connection</th>
                  <th scope="col">A retrying client</th>
                  <th scope="col">ZeroGate</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>What it concludes</td>
                  <td>The write failed</td>
                  <td>The outcome is unknown</td>
                </tr>
                <tr>
                  <td>Next action</td>
                  <td>Send it again</td>
                  <td>Ask the provider what committed</td>
                </tr>
                <tr>
                  <td>Writes reaching the provider</td>
                  <td>One or two</td>
                  <td>
                    Exactly one <span className="check" aria-hidden="true">✓</span>
                  </td>
                </tr>
                <tr>
                  <td>Evidence afterwards</td>
                  <td>Application logs</td>
                  <td>
                    Signed receipt over a hash-linked chain{" "}
                    <span className="check" aria-hidden="true">✓</span>
                  </td>
                </tr>
                <tr>
                  <td>If it cannot be resolved</td>
                  <td>Silent guess</td>
                  <td>
                    Reported as <code>UNKNOWN</code>{" "}
                    <span className="check" aria-hidden="true">✓</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section section--subtle" aria-labelledby="how-it-works">
        <div className="container">
          <div className="section-head">
            <Eyebrow>How it works</Eyebrow>
            <h2 id="how-it-works">Four steps, and none of them trust the response.</h2>
            <p>
              You describe one operation — how to read it, how to change it, and how to ask the
              provider what committed. ZeroGate supplies everything else.
            </p>
          </div>
          <ol className="steps">
            {steps.map((step) => (
              <li key={step.index}>
                <span className="steps__index">{step.index}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" aria-labelledby="outcomes">
        <div className="container">
          <div className="section-head">
            <Eyebrow>Outcomes</Eyebrow>
            <h2 id="outcomes">Six endings. Every one of them signed.</h2>
            <p>
              There is no ambiguous success. A run either proves what happened or states precisely
              what it could not determine.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Terminal state</th>
                  <th scope="col">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map(([state, meaning]) => (
                  <tr key={state}>
                    <td>
                      <code>{state}</code>
                    </td>
                    <td>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section section--subtle" aria-labelledby="requirements">
        <div className="container">
          <div className="section-head">
            <Eyebrow>What it needs from you</Eyebrow>
            <h2 id="requirements">Your provider has to be able to answer one question.</h2>
            <p>
              <strong>Did operation X commit?</strong> ZeroGate can only keep its promises if
              something on the provider&apos;s side can answer that. In practice, one of these:
            </p>
          </div>
          <div className="grid grid--3">
            <div className="card">
              <h3>An idempotency key</h3>
              <p>
                One it honours on write and can look up afterwards. Stripe-style keys are the
                clearest example.
              </p>
            </div>
            <div className="card">
              <h3>A client reference</h3>
              <p>
                A field you supply that the provider stores and returns, so you can query by it
                later.
              </p>
            </div>
            <div className="card">
              <h3>An audit trail</h3>
              <p>
                An event feed or history endpoint you can search for your own reference after the
                fact.
              </p>
            </div>
          </div>
          <p style={{ marginTop: "var(--space-8)", maxWidth: "var(--max-width-prose)" }}>
            Without one of those, a lost acknowledgement is genuinely unresolvable — and ZeroGate
            will tell you so rather than pretend otherwise.
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="limits">
        <div className="container">
          <div className="section-head">
            <Eyebrow>Limits</Eyebrow>
            <h2 id="limits">What this does not do.</h2>
            <p>
              A safety library that oversells itself is worse than none. These are the boundaries,
              stated before you depend on them.
            </p>
          </div>
          <div className="grid grid--2">
            {limits.map((limit) => (
              <div className="card" key={limit.title}>
                <h3>{limit.title}</h3>
                <p>{limit.body}</p>
              </div>
            ))}
          </div>
          <p style={{ marginTop: "var(--space-8)" }}>
            <Link href="/docs/limits">Read every current limitation →</Link>
          </p>
        </div>
      </section>

      <section className="section section--subtle" aria-labelledby="closing">
        <div className="container container--narrow stack stack--lg">
          <Eyebrow>Install</Eyebrow>
          <h2 id="closing">Install it, define one effect, and watch a dropped write resolve.</h2>
          <CodePanel filename="terminal" code="npm install zerogate" plain />
          <div className="button-row">
            <Link className="button button--primary" href="/docs/quickstart">
              Get started
            </Link>
            <a
              className="button button--secondary"
              href={GITHUB_URL}
              rel="noreferrer noopener"
              target="_blank"
            >
              View source <span aria-hidden="true">↗</span>
            </a>
          </div>
          <p className="micro-caption">
            Node 22 or newer · zero runtime dependencies · Apache-2.0
          </p>
        </div>
      </section>
    </PageShell>
  );
}
