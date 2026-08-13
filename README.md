# ZeroGate

**Find out what happened before retrying.**

Your code sends a request. The connection drops. You now have two choices, and both are wrong: retry and risk doing it twice, or give up and risk it having already happened.

ZeroGate refuses that choice. It treats a lost answer as `OUTCOME_UNKNOWN`, asks the provider what actually landed, verifies against authoritative state, and signs a receipt you can check without trusting the process that produced it.

**[usezerogate.vercel.app](https://usezerogate.vercel.app)** · [Documentation](docs/README.md) · [Limits](#limits)

```bash
npm install zerogate
```

```ts
import { TransactionEngine } from "zerogate";

const engine = new TransactionEngine({ adapter: publishDocument });

const result = await engine.run({
  input: { documentId: "doc_42", status: "published", tags: ["release"] },
  actor: { principalId: "u_1", agentId: "release-agent", agentVersion: "1.0.0" },
  purpose: "Publish the release notes",
  finalize: () => notifySubscribers()   // if this throws, the publish is undone
});

result.committed;                // true — verified against authoritative state
result.forwardDispatchCount;     // 1 — even if the acknowledgement was lost
result.summary;                  // one line, safe to log, true in every outcome
```

**Check `result.committed`.** Every other outcome — including the ones that mean *we cannot tell whether this happened* — returns normally rather than throwing. If you would rather handle one exception, call `assertCommitted(result)`.

## What you get

| Guarantee | What it means |
|---|---|
| No blind retries | A lost acknowledgement triggers reconciliation, never a second dispatch. |
| Approval bound to a payload | Consent covers one exact payload, contract, and observed state. Single-use. |
| Verification, not optimism | A provider's success response is evidence. Authoritative state is proof. |
| Compensation that refuses | If the record no longer matches what your effect produced, it will not overwrite it. |
| Signed receipts | Ed25519 over a hash-linked event chain, verifiable offline by a third party. |
| Credentials stay out | A credential-shaped value in a recorded field refuses the transaction before dispatch. |
| Honest unknowns | When the provider cannot say what happened, you get `UNKNOWN` — not a guess. |

## Defining an effect

You describe one operation. ZeroGate supplies the transaction semantics.

```ts
import { defineEffect, ProviderTimeoutAfterDispatchError } from "zerogate";
import contract from "./publish.effect.json" with { type: "json" };

type PublishInput = { documentId: string; status: string; tags: string[] };
type Document = { status: string; tags: string[]; version: number; updatedAt: string };

export const publishDocument = defineEffect<PublishInput, Document>({
  operation: "docs.publish",
  contract,                                  // its digest goes in every receipt
  materialFields: ["status", "tags"],        // the only fields this effect owns

  resourceScope: (input) => [{ type: "document", id: input.documentId }],
  observe: (input) => api.get(`/documents/${input.documentId}`),
  version: (state) => `${state.version}:${state.updatedAt}`,
  expected: (input, before) => ({ ...before, status: input.status, tags: input.tags }),

  async dispatch({ input, logicalOperationId, before }) {
    try {
      const response = await api.patch(`/documents/${input.documentId}`, {
        headers: { "idempotency-key": logicalOperationId, "if-match": `"${before.version}"` },
        body: { status: input.status, tags: input.tags }
      });
      return { providerRequestId: response.headers.get("x-request-id") ?? undefined };
    } catch (cause) {
      // The one rule that matters: never guess.
      throw new ProviderTimeoutAfterDispatchError();
    }
  },

  // "Did my dispatch commit?", answered by the provider — not inferred from state.
  findEvidence: ({ logicalOperationId }) => api.findOperation(logicalOperationId),

  async compensate({ input, restore, logicalOperationId }) {
    await api.patch(`/documents/${input.documentId}`, {
      headers: { "idempotency-key": logicalOperationId },
      body: restore
    });
  }
});
```

Write both type arguments — your input, and the provider state you observe. They are what makes `input.documentId` and `state.version` known inside every function above, and `defineEffect` cannot infer them.

Nothing in that file decides when to retry, what to approve, how to hash a payload, or when undoing is safe. Those are transaction concerns, and the engine owns them.

### What your provider must support

ZeroGate can only keep its promises if the provider can answer one question: **did operation X commit?** In practice that means one of

- an idempotency key it honours and can look up afterwards, or
- a client-supplied reference it stores and returns, or
- an audit log or event feed you can query by that reference.

Without one of those, a lost acknowledgement is genuinely unresolvable. ZeroGate will tell you so and stop, rather than pretend.

## Outcomes

`run()` returns; it does not throw. Every outcome below — including an unreachable provider and a definition that throws during preflight — ends in one terminal state with a signed receipt.

| State | `committed` | Meaning |
|---|---|---|
| `VERIFIED_COMMITTED` | `true` | The effect happened, exactly once, and authoritative state proves it. |
| `VERIFIED_COMPENSATED` | `false` | The effect happened and was then undone, and state proves both. |
| `MANUAL_RECOVERY_REQUIRED` | `false` | Genuinely unresolved. `result.recovery` says what to do. |
| `ABORTED` | `false` | State moved after approval. Nothing was dispatched. |
| `PREFLIGHT_FAILED` | `false` | No material effect, or a precondition failed. `result.refusal` says which. |
| `APPROVAL_DENIED` | `false` | The approval did not match the payload. Nothing was dispatched. |

Faults in the engine itself — an unreachable ledger, an impossible state transition — still throw, because they are not outcomes of your effect.

### When you are paged

```ts
if (!result.committed) {
  logger.error(result.summary);        // one line, already written for a human
}

if (result.recovery) {
  result.recovery.reason;                  // why it could not be resolved
  result.recovery.instruction;             // what to do about it
  result.recovery.logicalOperationId;      // ask the provider about this
  result.recovery.effectMayHaveCommitted;  // false only on a definitive rejection
  result.recovery.observedMatchesExpected; // present, but nothing attributes it here
}
```

The last two are the difference between *it may have landed* and *it never left*, which is the first thing anyone needs at 3am.

## Testing your effect

The engine's guarantees hold only if your definition can answer "did operation X commit?". The suite ZeroGate runs against itself is exported, so you can point it at yours:

```ts
import test from "node:test";
import { assertEffectVerified, verifyEffect } from "zerogate/testing";

test("publish survives a lost acknowledgement", async () => {
  assertEffectVerified(
    await verifyEffect({
      setup: async () => ({ adapter: createPublishEffect(baseUrl), input: PUBLISH_INPUT })
    })
  );
});
```

It commits the effect for real, then drops the acknowledgement on the floor and checks that `findEvidence` can recover it without a second dispatch. Then it does the harder one: it lets *somebody else* make exactly the change your effect intended, loses your dispatch, and checks that you do not claim their work as yours. An effect whose `findEvidence` reads current state passes every other check and fails that one.

Plus canonical-input stability, observation stability, no-op refusal, compensation, and — if you supply `concurrentEdit` — that compensation refuses to overwrite somebody else's write.

Every failure names the function to change.

## CLI

```bash
# Verify a receipt without trusting whoever produced it
npx zerogate receipt verify receipt.json events.json signing-key.pub.pem

# Pin a contract digest in code
npx zerogate contract digest ./publish.effect.json

# Generate an Ed25519 receipt-signing keypair
npx zerogate keys new --out .zerogate/keys
```

## Durable ledgers

The default event ledger is in-memory. For anything that must survive a restart:

```ts
import { TransactionEngine } from "zerogate";
import { PostgresEventLedger } from "zerogate/postgres";

const engine = new TransactionEngine({
  adapter: publishDocument,
  ledger: new PostgresEventLedger({
    tenantId: "acme",                       // the ledger is isolated per tenant
    connectionString: process.env["DATABASE_URL"]!
  })
});
```

`SqliteLedger` is also exported for single-process durability. Apply the PostgreSQL schema from [`migrations/`](migrations) — in this repo, `npm run db:up && npm run db:migrate`.

## Signing keys

By default the engine signs with a keypair that dies with the process: internally consistent, and unverifiable by anyone, ever. It says so once as a process warning. For anything you intend to audit, keep the key:

```ts
import { ReceiptSigner, TransactionEngine } from "zerogate";
import { readFileSync } from "node:fs";

const engine = new TransactionEngine({
  adapter: publishDocument,
  receiptSigner: ReceiptSigner.fromPem(readFileSync(process.env["RECEIPT_KEY_PATH"]!, "utf8"))
});
```

`result.receiptKeyRetention` tells you which you got. Pass `receiptSigner: "ephemeral"` to accept a throwaway key deliberately and silence the warning.

## Limits

Stated plainly, because a safety library that oversells itself is worse than none:

- **This is not exactly-once delivery.** No library can provide that across a network. ZeroGate provides *at-most-one verified effect per approved payload*, plus honest reporting when it cannot tell.
- **Reconciliation is only as good as your provider's evidence.** See the requirements above.
- **Compensation is not a rollback.** It is a second, forward, conditional write. It is refused when the record has moved on.
- **One action per transaction.** Multi-action transactions are not implemented.
- **Approvals are payload-bound tokens, not a human approval service.** Wiring them to a real approver is your responsibility, and replay protection is process-local until you back the nonce store with shared storage.

## Development

Node.js 22 or newer.

```bash
npm install
npm run validate     # lint, types, tests, build, and a real tarball install test
npm test
```

The test suite runs the whole engine against a real HTTP service over real sockets — including dropped connections mid-write, concurrent edits, and providers that cannot explain themselves. See [`examples/rest-resource`](examples/rest-resource).

Optional PostgreSQL ledger tests. They **skip silently** without the environment variable, so check for `pass 1` rather than assuming they ran:

```bash
npm run db:up
ZEROGATE_TEST_ADMIN_DATABASE_URL=postgresql://postgres:zerogate@127.0.0.1:5432/postgres npm run test:postgres
```

## Documentation

The full reference is one page: [docs/README.md](docs/README.md).

| If you want to | Read |
|---|---|
| Understand the core terms | [Concepts](docs/README.md#concepts) |
| See every terminal outcome | [State model](docs/README.md#state-model) |
| Read a result correctly | [Reading a result](docs/README.md#reading-a-result) |
| Prove your own effect is sound | [Testing an effect](docs/README.md#testing-an-effect) |
| Verify evidence independently | [Receipts](docs/README.md#receipts) |
| Pin an operation | [Effect contracts](docs/README.md#effect-contracts) |
| Read every current limitation | [Limits](docs/README.md#limits) |

## License

Apache-2.0. See [LICENSE](LICENSE).
