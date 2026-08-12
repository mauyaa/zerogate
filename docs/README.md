# ZeroGate reference

One page, because a reference split across seven files drifts out of sync with itself.

- [Concepts](#concepts)
- [Defining an effect](#defining-an-effect)
- [State model](#state-model)
- [Receipts](#receipts)
- [Effect contracts](#effect-contracts)
- [Ledgers](#ledgers)
- [CLI](#cli)
- [Limits](#limits)

---

## Concepts

**Witness** — authoritative provider state observed while building the preview, plus a version marker. Approval is bound to it, and it is re-checked immediately before dispatch. If it moved, the approved preview no longer describes reality and nothing is sent.

**Material field** — a field this effect claims ownership of. Only material fields are diffed, verified, and restored. Everything else on the record is none of the effect's business, which is what makes compensation safe to reason about.

**Logical operation ID** — a stable identifier for one intended dispatch. It goes to the provider as an idempotency key or client reference, so that afterwards you can ask whether that exact attempt committed.

**Outcome unknown** — the request left the process and no answer arrived. Not a failure and not a success. Collapsing this into "failed" is the bug ZeroGate exists to prevent.

**Reconciliation** — asking the provider what committed, keyed by the logical operation ID. Resolves an unknown outcome without a second dispatch.

**Finality** — how strongly the outcome is known: `VERIFIED` when authoritative state confirms it, `PROVIDER_ATTESTED` when only the provider's record does, `UNKNOWN` when nothing does, `DISPUTED` when evidence disagrees.

The distinction everything rests on: a provider's success response is **evidence**. Authoritative state is **proof**.

---

## Defining an effect

`defineEffect` implements every transaction-safety rule once. Your definition supplies provider knowledge only.

```ts
import { defineEffect, ProviderTimeoutAfterDispatchError } from "zerogate";
import contract from "./publish.effect.json" with { type: "json" };

export const publishDocument = defineEffect({
  operation: "docs.publish",
  contract,
  materialFields: ["status", "tags"],

  resourceScope: (input) => [{ type: "document", id: input.documentId }],
  observe: (input) => api.getDocument(input.documentId),
  version: (state) => `${state.version}:${state.updatedAt}`,
  expected: (input, before) => ({ ...before, status: input.status, tags: input.tags }),

  async dispatch({ input, before, logicalOperationId }) {
    try {
      const response = await api.patchDocument(input.documentId, {
        idempotencyKey: logicalOperationId,
        ifMatch: before.version,
        body: { status: input.status, tags: input.tags }
      });
      return { providerRequestId: response.requestId };
    } catch {
      throw new ProviderTimeoutAfterDispatchError();
    }
  },

  findEvidence: ({ logicalOperationId }) => api.findOperation(logicalOperationId),

  compensate: ({ input, restore, logicalOperationId }) =>
    api.patchDocument(input.documentId, { idempotencyKey: logicalOperationId, body: restore })
});
```

### Optional fields worth knowing

| Field | Why it exists |
|---|---|
| `normalizeState` | Comparison is exact. Without this, a meaningless array reorder reads as a material change and dispatches a write that changes nothing. |
| `canonicalizeInput` | Makes equivalent requests hash identically, so approval binding is stable. |
| `redactFields` | Hashes a field into evidence instead of recording its value. |
| `restore` | Overrides the default restore values (the witness values for changed fields). |
| `residualRisk` | Honest limits recorded in every receipt, even on the success path. |
| `witnessStrength` | How strong the freshness guarantee actually is: `strong`, `medium`, `weak`, `none`. |

Omitting `compensate` makes the effect non-compensatable. It will never be auto-undone.

### What your provider must support

`findEvidence` must answer **"did operation X commit?"** from the provider's own records — an idempotency key it can look up, a client reference it stores and returns, or an audit trail you can search. Inferring it from current state is not sufficient, because anything else could have produced that state.

Without one of these, a lost acknowledgement is genuinely unresolvable, and ZeroGate reports that instead of guessing.

---

## State model

Transitions are checked. An illegal move throws `INVALID_STATE_TRANSITION` rather than silently producing a state the evidence does not support.

| Terminal state | Finality | How it is reached |
|---|---|---|
| `VERIFIED_COMMITTED` | `VERIFIED` | The effect dispatched or was proven committed, and state matches the approved postcondition. |
| `VERIFIED_COMPENSATED` | `VERIFIED` | The effect committed, downstream work failed, and compensation was safe, dispatched, and verified. |
| `MANUAL_RECOVERY_REQUIRED` | `UNKNOWN` / `DISPUTED` | Unresolvable outcome, failed verification, or blocked/unproven compensation. |
| `ABORTED` | `VERIFIED` | State moved between approval and dispatch. Nothing was sent. |
| `PREFLIGHT_FAILED` | `VERIFIED` | No material change, or a precondition failed. |
| `APPROVAL_DENIED` | `VERIFIED` | The approval did not match the payload. Nothing was sent. |

Four of the six endings involve nothing having been dispatched. Refusing early is the common case.

### The unknown-outcome path

`dispatch` throws `ProviderTimeoutAfterDispatchError`. The action moves to `OUTCOME_UNKNOWN` and the transaction to `RECONCILING`. No retry is attempted — `forwardDispatchCount` stays at 1 for the life of the transaction. Then exactly one of:

1. **Evidence found** — the dispatch committed. State is verified as normal, and the provider request ID recovered from that evidence is recorded.
2. **No evidence, expected state present** — still unresolved. Nothing attributes that state to this transaction, so retry and compensation both stay blocked. This is the case naive implementations get wrong.
3. **No evidence, no matching state** — unresolved, reported as `UNKNOWN`.

### Why compensation refuses

Compensation is a second forward write, not a rollback. Before planning one, ZeroGate re-reads state and checks that every material field still matches what the forward effect produced. If anything moved, the action ends `COMPENSATION_BLOCKED` — the alternative is destroying somebody else's work to tidy up your own.

---

## Receipts

Every terminal outcome produces an Ed25519 signature over a canonical body, bound to the root of a hash-linked event chain.

The signature covers the intent binding (tenant, environment, actor, purpose, resource scope, expiry, limits hash, action-set root, policy version), the action (operation, logical operation ID, payload hash, contract digest, status, finality, attempt IDs, provider request IDs), the ordered observations, the chain root, and the residual risk.

```bash
npx zerogate receipt verify receipt.json events.json signing-key.pub.pem
```

Or in code:

```ts
import { verifyReceipt, verifyEventChain } from "zerogate";

verifyReceipt(receipt, publicKeyPem);
verifyEventChain(covered).root === receipt.integrity.eventChainRoot;
```

**Both checks are required.** A valid signature alone proves the body was signed by that key. Re-deriving the chain root proves the receipt describes the history it claims to.

By default the engine generates an ephemeral keypair that dies with the process — internally consistent and permanently unverifiable. Supply a retained key for anything you intend to audit:

```ts
import { ReceiptSigner, TransactionEngine } from "zerogate";
import { readFileSync } from "node:fs";

const engine = new TransactionEngine({
  adapter: publishDocument,
  receiptSigner: ReceiptSigner.fromPem(readFileSync(process.env.RECEIPT_KEY_PATH, "utf8"))
});
```

### Credentials never reach a receipt

If a material field's value has the shape of a credential — a PEM private key, a GitHub or npm token, an AWS key ID, a JWT, a bearer token — the transaction is refused during preflight, before anything is dispatched, and the error names the field and tells you to add it to `redactFields`.

The check matches credential *shapes* only, never words like "password" or "secret", so a document titled "Password reset" is ordinary content.

---

## Effect contracts

A contract is the pinned description of one operation. Its canonical digest (RFC 8785 JCS) is bound into both the approval and the receipt, so changing the contract invalidates approvals issued against the old one. An approval can never outlive the meaning of the thing it approved.

```bash
npx zerogate contract digest ./publish.effect.json
```

Pin that digest in a test. ZeroGate does not interpret the contract as a program — your `defineEffect` functions do the work, and the contract records what they are supposed to guarantee. Keeping the two in agreement is your responsibility, which is why the digest is worth asserting.

See [`examples/rest-resource/document-publish.effect.json`](../examples/rest-resource/document-publish.effect.json) for a complete one.

---

## Ledgers

| Ledger | Use |
|---|---|
| `InMemoryEventLedger` | Default. Tests, and work that need not survive a restart. |
| `SqliteLedger` | Single-process durability. |
| `PostgresEventLedger` | Tenant-scoped, append-only, row-level security. Import from `zerogate/postgres`. |

```ts
import { PostgresEventLedger } from "zerogate/postgres";

const engine = new TransactionEngine({
  adapter: publishDocument,
  ledger: new PostgresEventLedger({ connectionString: process.env.DATABASE_URL })
});
```

Apply the schema from [`migrations/`](../migrations). In this repo, `npm run db:up && npm run db:migrate`.

The engine does not resume an interrupted transaction from a ledger on startup. A process killed mid-transaction leaves a durable event history and no automatic continuation.

---

## CLI

```bash
npx zerogate receipt verify <receipt.json> <events.json> <public-key.pem>
npx zerogate contract digest <contract.json>
npx zerogate keys new [--out <dir>] [--name <name>]
```

`receipt verify` exits non-zero on any failed check, so it drops into CI directly.

---

## Limits

- **Not exactly-once delivery.** Nothing provides that across a network. ZeroGate provides at most one verified effect per approved payload, plus an honest report when it cannot determine what happened.
- **Reconciliation depends entirely on your provider's evidence.** See above.
- **Compensation is a forward write.** Refused whenever a material field no longer matches the forward result.
- **One action per transaction.** Multi-action transactions, dependency ordering, and partial-commit release conditions are modelled in the state machine but not implemented.
- **Approvals are tokens, not an approval service.** `ApprovalAuthority` issues and consumes single-use payload-bound mandates. It asks no human anything.
- **Replay protection for approvals is process-local.** Consumed nonces are held in memory by the `ApprovalAuthority` instance, so a restart, or a second instance, will accept a mandate that was already used. Back it with shared storage before issuing approvals across processes.
- **The freshness check is not atomic.** It narrows the window between approval and mutation without closing it. Use a provider-side conditional write where one exists.
- **The default ledger does not survive a restart.**
- **Ephemeral signing keys make receipts unverifiable later.**

What is verified: the test suite runs the whole engine against a real HTTP service over real sockets — connections dropped after the write commits, concurrent edits between verification and compensation, providers that cannot explain themselves, and idempotency keys replayed with a different payload.

What is not: sustained production load, adversarial providers, clock skew across distributed signers, and every provider API other than the example.
