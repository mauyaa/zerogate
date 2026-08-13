# ZeroGate reference

One page, because a reference split across seven files drifts out of sync with itself.

- [Concepts](#concepts)
- [Defining an effect](#defining-an-effect)
- [State model](#state-model)
- [Reading a result](#reading-a-result)
- [Testing an effect](#testing-an-effect)
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

type PublishInput = { documentId: string; status: string; tags: string[] };
type Document = { status: string; tags: string[]; version: number; updatedAt: string };

export const publishDocument = defineEffect<PublishInput, Document>({
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

  async compensate({ input, restore, logicalOperationId }) {
    await api.patchDocument(input.documentId, {
      idempotencyKey: logicalOperationId,
      body: restore
    });
  }
});
```

**Write both type arguments.** `defineEffect` cannot infer them: every function in the definition is contextually typed, so there is nothing for TypeScript to infer `TState` from, and it falls back to `object`. `defineEffect<PublishInput, Document>` is what makes `state.version` and `input.documentId` known inside every function above.

`dispatch` and `compensate` may return nothing at all. Return `{ providerRequestId }` only when the provider gives you an identifier worth recording. `findEvidence` may return `undefined` or `null` for "no such operation" — whichever your lookup already produces.

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

`run()` returns a result for every one of them, including cases where the effect definition itself threw before the dispatch boundary — an unreachable provider, a credential caught by the evidence guard, a bug in `observe`. Those arrive as `PREFLIGHT_FAILED` with `result.refusal` set, and the original error on `result.refusal.cause`. What still throws is a fault in the engine or its ledger: an impossible state transition, a ledger that cannot be written. Those are not outcomes of your effect and must not be mistaken for one.

---

## Reading a result

```ts
result.committed;    // the only success test: verified against authoritative state
result.summary;      // one line, already phrased for a human, true in every outcome
result.refusal;      // set when nothing was dispatched, and why
result.recovery;     // set when a human has to finish the job
```

`assertCommitted(result)` throws instead, for callers who would rather handle one exception than a state machine; the thrown error carries `refusal.cause` so a bug in a definition keeps its stack.

| Field on `result.recovery` | Answers |
|---|---|
| `reason` | Why the engine could not resolve it |
| `instruction` | What to do next, naming the resource |
| `logicalOperationId` | The identifier to ask the provider about |
| `effectMayHaveCommitted` | `false` only after a definitive provider rejection |
| `observedMatchesExpected` | Whether the intended change is present but unattributed |

The last two separate *it may have landed* from *it never left*. Both are `MANUAL_RECOVERY_REQUIRED`, and they call for opposite actions.

`result.action.observations` is a discriminated union on `kind`, so reading the evidence is a `switch`, not a cast:

```ts
for (const observation of result.action.observations) {
  if (observation.kind === "reconciliation") observation.committed;
  if (observation.kind === "verification") observation.ok;
}
```

---

## Testing an effect

The engine's guarantees are only as good as the definition underneath them, and `findEvidence` is where they break. The suite ZeroGate runs against itself is exported for pointing at yours:

```ts
import test from "node:test";
import { assertEffectVerified, verifyEffect } from "zerogate/testing";

test("publish survives the chaos suite", async () => {
  assertEffectVerified(
    await verifyEffect({
      // Called once per scenario. Return a provider in a known starting state.
      setup: async () => ({ adapter: createPublishEffect(baseUrl), input: PUBLISH_INPUT }),
      concurrentEdit: async () => { /* write to the same resource out of band */ }
    })
  );
});
```

| Scenario | What a failure means |
|---|---|
| `commits-once` | The effect does not work at all, or dispatches more than once. |
| `canonical-input-is-stable` | `canonicalizeInput` is not idempotent, so approvals bind to a moving payload. |
| `observation-is-stable` | Something time-varying reaches the witness; freshness checks will abort healthy runs. |
| `lost-acknowledgement-is-recoverable` | `findEvidence` cannot prove your own dispatch. Every dropped connection becomes a page. |
| `undispatched-request-is-not-claimed` | `findEvidence` reports success for an operation that never ran. |
| `foreign-change-is-not-claimed` | `findEvidence` reads current state rather than provider evidence, so it claims changes other writers made — and compensation will then undo their work. |
| `repeat-is-refused-as-no-op` | `expected()` does not describe what `dispatch` leaves behind. Every receipt diff is fiction. |
| `downstream-failure-is-compensated` | Compensation does not work, or none is declared. |
| `compensation-refuses-concurrent-edit` | Compensation overwrites writes it does not own. Narrow `materialFields`. |

The suite mutates the provider for real: `setup` must return a fresh starting state each time it is called. Scenarios needing a hook you did not supply are reported as skipped rather than quietly passed.

### The unknown-outcome path

`dispatch` throws `ProviderTimeoutAfterDispatchError` — or throws anything the definition did not classify, which says just as little about whether the request left. The action moves to `OUTCOME_UNKNOWN` and the transaction to `RECONCILING`. No retry is attempted — `forwardDispatchCount` stays at 1 for the life of the transaction. Then exactly one of:

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
  receiptSigner: ReceiptSigner.fromPem(readFileSync(process.env["RECEIPT_KEY_PATH"]!, "utf8"))
});
```

Leaving `receiptSigner` unset emits a process warning, because a silently unverifiable receipt is the version of this mistake that reaches production. Pass the literal `"ephemeral"` to accept that deliberately and silence it — `result.receiptKeyRetention` reports which you got.

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

See [`examples/rest-resource/document-publish.effect.json`](https://github.com/mauyaa/zerogate/blob/main/examples/rest-resource/document-publish.effect.json) for a complete one.

---

## Ledgers

| Ledger | Use |
|---|---|
| `InMemoryEventLedger` | Default. Tests, and work that need not survive a restart. |
| `SqliteLedger` | Single-process durability. |
| `PostgresEventLedger` | Tenant-scoped, append-only, row-level security. Import from `zerogate/postgres`. |

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

Apply the schema from [`migrations/`](../migrations). In this repo, `npm run db:up && npm run db:migrate`.

The engine does not resume an interrupted transaction from a ledger on startup. A process killed mid-transaction leaves a durable event history and no automatic continuation.

---

## CLI

```bash
npx zerogate receipt verify <receipt.json> <events.json> <public-key.pem>
npx zerogate contract digest <contract.json>
npx zerogate keys new [--out <dir>] [--name <name>]
```

`receipt verify` exits non-zero on any failed check, so it drops into CI directly. Its output leads with `finalStatus`, and names the verdict `authentic` rather than `ok`: a receipt for a transaction that needed a human is a perfectly authentic receipt, and the two questions must not be confused.

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

### What is actually verified

The suite runs the whole engine against real providers, not stand-ins for them:

- **Real sockets.** The example service is a real HTTP server. Connections are destroyed mid-write after the change commits, so a lost acknowledgement is genuinely lost.
- **Adversarial providers.** A provider that reports success while writing nothing, one that fabricates evidence for an operation that never committed, one that contradicts itself between reads, and one that reverts the effect after verification. The invariant asserted throughout: no provider behaviour can produce a `VERIFIED_COMMITTED` receipt unless authoritative state genuinely matches the approved postcondition.
- **Contention and volume.** Thirty-two transactions racing for one record, and two hundred running concurrently, asserting arithmetically that the provider's write count equals the engine's dispatch count — a duplicate effect would show up as a mismatch. Ledger chains stay intact and per-transaction sequences stay contiguous under interleaving.
- **Clock skew.** Approvals issued and consumed under clocks running ahead and behind each other, including the exact expiry boundary, replay after a rewound clock, and a ledger receiving out-of-order timestamps.
- **A structurally opposite provider.** An append-only ledger with no conditional write, no in-place update, evidence discoverable only by search, and compensation by reversing entry rather than restored field — driven by the same engine with no changes.

### What is still not verified

- **Time in production.** No amount of testing substitutes for running under real traffic for months. This is a 0.x release and should be treated as one.
- **Provider APIs beyond these shapes.** Two shapes are covered. Yours may differ in ways neither anticipates.
- **Crash recovery.** A process killed mid-transaction leaves a durable event history and no automatic continuation; nothing resumes it for you.
- **Multi-node approval state.** Replay protection is process-local, as noted above.
