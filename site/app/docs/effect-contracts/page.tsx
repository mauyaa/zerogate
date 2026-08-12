import type { Metadata } from "next";
import Link from "next/link";
import { CodePanel } from "../../../components/code-panel";
import { Callout, DocPage } from "../../../components/docs-shell";

export const metadata: Metadata = {
  title: "Effect contracts",
  description:
    "How pinning an operation's contract keeps an approval from outliving the meaning of the thing it approved.",
};

const CONTRACT = `{
  "apiVersion": "effects.zerogate.dev/v1alpha1",
  "kind": "EffectContract",
  "metadata": {
    "name": "docs.publish",
    "version": "1.0.0",
    "provider": "internal-docs-api",
    "operation": "documents.publish"
  },
  "spec": {
    "effect": {
      "class": "compensatable",
      "resourceType": "document",
      "materialFields": ["status", "tags"]
    },
    "idempotency": {
      "strategy": "provider_idempotency_key",
      "keyTemplate": "{{logicalOperationId}}",
      "payloadEqualityRequired": true
    },
    "verification": {
      "required": true,
      "strategy": "fetch_and_compare_material_fields"
    },
    "reconciliation": {
      "strategies": ["provider_operation_lookup_by_idempotency_key"],
      "deadlineSeconds": 300
    },
    "recovery": {
      "mode": "exact_restore",
      "preconditions": [{ "kind": "current_fields_equal_forward_result" }]
    }
  }
}`;

const DIGEST = `npx zerogate contract digest ./publish.effect.json
# sha256:b69907f1fe0da3883ad2a0b2fdc20a8efb5786094c0b5ea5d46a5feae1364d0c`;

export default function EffectContractsPage() {
  return (
    <DocPage
      current="/docs/effect-contracts"
      title="Effect contracts"
      lead="A contract is the pinned description of one operation. Its digest travels with every approval and every receipt."
    >
      <p>
        An approval says &quot;you may do <em>this</em>&quot;. For that to mean anything later,{" "}
        <em>this</em> has to be pinned — not just the payload, but the semantics of the operation the
        payload will be sent to. The contract is that pin, and its canonical digest is bound into
        both the approval and the receipt.
      </p>
      <p>
        The consequence is the point: change the contract, and the digest changes, and approvals
        issued against the old one stop matching. An approval can never outlive the meaning of the
        thing it approved.
      </p>

      <h2>What a contract declares</h2>
      <CodePanel filename="publish.effect.json" code={CONTRACT} />

      <p>
        Pass it straight to <code>defineEffect</code> as the <code>contract</code> field. ZeroGate
        hashes it canonically (RFC 8785 JCS), so key order and insignificant formatting cannot change
        the digest.
      </p>

      <Callout title="The contract documents; the definition executes.">
        <p>
          ZeroGate does not interpret the contract as a program. Your{" "}
          <code>defineEffect</code> functions do the work, and the contract records what those
          functions are supposed to guarantee — for reviewers, for auditors, and for digest stability.
          Keeping the two in agreement is your responsibility, which is exactly why the digest is
          worth recording.
        </p>
      </Callout>

      <h2>Pinning the digest</h2>
      <p>
        Print the digest and assert it in a test. If someone edits the contract without thinking
        about the approvals it governs, that test is what tells them.
      </p>
      <CodePanel filename="terminal" code={DIGEST} plain />

      <h2>Choosing material fields</h2>
      <p>
        <code>materialFields</code> is the most consequential line in the file. It defines what the
        effect owns, and therefore what compensation is permitted to touch. Declare the narrowest set
        that captures your intent: a wider set makes compensation more likely to be blocked by
        unrelated edits, and a wrong one lets an undo overwrite a field the effect never set.
      </p>
      <p>
        Fields whose values should not appear in evidence go in <code>redactFields</code>. They are
        hashed into the receipt instead of recorded, so the diff remains verifiable without
        publishing the content. See <Link href="/docs/receipts">receipts</Link>.
      </p>
    </DocPage>
  );
}
