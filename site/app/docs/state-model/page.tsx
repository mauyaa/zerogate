import type { Metadata } from "next";
import Link from "next/link";
import { DocPage } from "../../../components/docs-shell";

export const metadata: Metadata = {
  title: "State model",
  description:
    "Every terminal outcome a ZeroGate transaction can reach, how it is reached, and what it licenses you to do next.",
};

const terminals = [
  {
    state: "VERIFIED_COMMITTED",
    finality: "VERIFIED",
    reached:
      "The effect dispatched (or was proven committed by reconciliation) and authoritative state matches the approved postcondition.",
    next: "Treat the effect as done. The receipt proves it.",
  },
  {
    state: "VERIFIED_COMPENSATED",
    finality: "VERIFIED",
    reached:
      "The effect committed, downstream work failed, compensation was safe, dispatched, and verified against state.",
    next: "Treat the effect as never having stood. Both writes are in the receipt.",
  },
  {
    state: "MANUAL_RECOVERY_REQUIRED",
    finality: "UNKNOWN or DISPUTED",
    reached:
      "The outcome could not be resolved, verification failed, or compensation was blocked or unproven.",
    next: "Do not retry programmatically. The receipt names exactly what is unresolved.",
  },
  {
    state: "ABORTED",
    finality: "VERIFIED",
    reached:
      "The freshness re-check found that state moved between approval and dispatch. Nothing was sent.",
    next: "Build a new preview and obtain a new approval.",
  },
  {
    state: "PREFLIGHT_FAILED",
    finality: "VERIFIED",
    reached: "The requested change had no material effect, or a precondition did not hold.",
    next: "Nothing happened. Fix the input.",
  },
  {
    state: "APPROVAL_DENIED",
    finality: "VERIFIED",
    reached:
      "The supplied approval did not match the payload, contract, witness, or limits — or it was expired or already used.",
    next: "Nothing was dispatched. Obtain a correctly bound approval.",
  },
];

export default function StateModelPage() {
  return (
    <DocPage
      current="/docs/state-model"
      title="State model"
      lead="Six terminal states. Each one is reached by a specific proof, and each one carries a signed receipt."
    >
      <p>
        Transitions are checked, not implied. An illegal move throws{" "}
        <code>INVALID_STATE_TRANSITION</code> rather than silently producing a state the evidence
        does not support. Notice that four of the six endings involve nothing having been dispatched
        — refusing early is the common case, not the exception.
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Terminal state</th>
              <th scope="col">Finality</th>
              <th scope="col">How it is reached</th>
              <th scope="col">What you may do</th>
            </tr>
          </thead>
          <tbody>
            {terminals.map((row) => (
              <tr key={row.state}>
                <td>
                  <code>{row.state}</code>
                </td>
                <td>{row.finality}</td>
                <td>{row.reached}</td>
                <td>{row.next}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>The unknown-outcome path</h2>
      <p>
        This is the sequence the whole library exists for. A dispatch throws{" "}
        <code>ProviderTimeoutAfterDispatchError</code>. The action moves to{" "}
        <code>OUTCOME_UNKNOWN</code>, and the transaction to <code>RECONCILING</code>. No retry is
        attempted — the dispatch counter stays at one for the life of the transaction.
      </p>
      <p>Reconciliation then asks the provider what committed, and exactly one of these follows:</p>
      <ul>
        <li>
          <strong>Evidence found.</strong> The dispatch committed. State is verified as normal, and
          the provider request ID recovered from that evidence is recorded in the receipt.
        </li>
        <li>
          <strong>No evidence, but the expected state is present.</strong> Still unresolved — nothing
          attributes that state to this transaction, so both retry and compensation stay blocked.
          This is the case naive implementations get wrong.
        </li>
        <li>
          <strong>No evidence and no matching state.</strong> Unresolved, reported as{" "}
          <code>UNKNOWN</code>.
        </li>
      </ul>

      <h2>Why compensation can refuse</h2>
      <p>
        Compensation is a second forward write, not a rollback. Before planning one, ZeroGate re-reads
        state and checks that every material field still matches what the forward effect produced. If
        anything moved, the plan is unsafe and the action ends{" "}
        <code>COMPENSATION_BLOCKED</code> — because the alternative is destroying somebody
        else&apos;s work to tidy up your own.
      </p>
      <p>
        An effect that declares no <code>compensate</code> function is never auto-undone at all. See{" "}
        <Link href="/docs/limits">limits</Link>.
      </p>
    </DocPage>
  );
}
