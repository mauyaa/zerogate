# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.0

A developer-experience release. The engine's guarantees did not change; what changed is how much of the first hour is spent fighting the package instead of using it, and how much of a bad outcome you are handed rather than left to dig for.

### Added

- **`zerogate/testing`.** The chaos suite this project runs against itself, exported so it can be pointed at your effect. It commits the effect for real and then drops the acknowledgement, checking that `findEvidence` can recover the outcome without a second dispatch. Then it lets a different writer make exactly the change your effect intended, loses your dispatch, and checks that you do not claim their work — the one scenario a `findEvidence` that reads current state fails, while passing every other check. Also covers canonical-input stability, observation stability, an operation that never left, no-op refusal, compensation, and, given a `concurrentEdit` hook, that compensation refuses to overwrite somebody else's write. Every failure names the function to change.
- **`result.committed`** — the one boolean that answers "did this happen?".
- **`result.summary`** — one line, already phrased for a human, correct in every outcome.
- **`result.recovery`** — the operator packet for `MANUAL_RECOVERY_REQUIRED`, promoted out of `action.observations`. It carries the reason, an instruction naming the resource, the `logicalOperationId` to ask the provider about, and two fields that separate *it may have landed* from *it never left*: `effectMayHaveCommitted` and `observedMatchesExpected`.
- **`result.refusal`** — why nothing was dispatched, with the original error on `.cause`.
- **`assertCommitted(result)`**, for callers who prefer one exception to a state machine.
- **`result.receiptKeyRetention`**, and a one-time process warning when receipts are signed with an ephemeral key. The default was convenient and silently worthless for audit, which is the combination that reaches production unnoticed. `receiptSigner: "ephemeral"` accepts it deliberately and silences the warning.
- **`Observation` is a discriminated union** on `kind`, so reading recorded evidence is a `switch` rather than an index-signature cast.
- A test that compiles every TypeScript example in `README.md` and `docs/README.md`, at plain `strict: true`.

### Fixed

- **An unclassified throw from `dispatch` was reported as a definitive provider rejection**, complete with "nothing committed and there is nothing to undo" — while the change could be sitting in the provider. A throw that is not a `ZeroGateError` says nothing about whether the request left, so it is now treated as an unknown outcome and reconciled, and the note names the two errors to throw instead. This was the library's own rule being broken in the library.
- **The quickstart did not compile.** `defineEffect({...})` cannot infer its type parameters — every function in the definition is contextually typed, so `TState` fell back to `object` and `version: (state) => state.version` failed with `TS2339`. Both documented examples now write `defineEffect<PublishInput, Document>` and say why. Three further snippets did not compile either: a `string | null` request ID, an unchecked `process.env` read, and a `PostgresEventLedger` missing its required `tenantId`.
- **`require("zerogate")` failed** with `ERR_PACKAGE_PATH_NOT_EXPORTED` — a message that does not even mention ESM. The exports map now offers a `default` condition, so CommonJS callers on Node 22.12+ work.
- **A typo in `materialFields` produced `Unsupported value at $: undefined`.** A material field absent from observed state now raises an error naming the field and listing the fields that were actually there. A field the effect *creates* — absent before, present after — is now an ordinary diff rather than a canonicalisation failure.
- **Preflight rejections dropped their message.** The engine knew "The requested change has no material effect" and reported only `UNSUPPORTED`. The reason is now in the note, the observation, and `result.refusal`.
- **`docs/README.md` was not in the published tarball**, though `README.md` calls it the full reference.
- Compensation that would have to remove a field it created is refused with an explanation, rather than failing to canonicalise `undefined`.

### Changed

- **`run()` no longer throws for provider or definition faults.** An unreachable provider, a credential caught by the evidence guard, or an effect that throws during `observe` now end as `PREFLIGHT_FAILED` with a signed receipt and `result.refusal`, instead of escaping as an exception with no record. Faults in the engine or its ledger still throw, because they are not outcomes of your effect. **This is a behaviour change**: code that relied on `run()` rejecting must check `result.committed`.
- `dispatch` and `compensate` may return nothing; `findEvidence` may return `null` as well as `undefined`. All three matched what real provider clients already do and previously did not typecheck.
- **Breaking:** `zerogate receipt verify` reports `authentic` instead of `ok`, and leads with `finalStatus`. A receipt for a transaction that needed a human is a perfectly authentic receipt; conflating the two questions invited exactly the wrong reading. The exit code is unchanged.
- `manualRecovery` entries carry an `instruction` that names the resource and the next step, rather than a generic sentence. The one entry that carried no instruction at all now does.

## 0.4.0

### Fixed

- **The published type declarations no longer reference `node:crypto`.** `ReceiptSigner` and `ApprovalAuthority` exposed a `KeyObject` constructor parameter, which made their `.d.ts` files import a Node built-in. Any consumer compiling with `skipLibCheck: false` got `TS2307: Cannot find module 'node:crypto'` unless they separately installed `@types/node`. Both constructors now take a PKCS#8 PEM string, and no shipped declaration imports a Node built-in.

### Changed

- **Breaking:** `new ReceiptSigner(key)` and `new ApprovalAuthority(key)` take a PEM `string` instead of a `KeyObject`. `ReceiptSigner.fromPem()` and `ApprovalAuthority.fromPem()` are unchanged and remain the recommended way to supply a retained key.

### Added

- Tests closing the four gaps the limits pages previously listed as unverified: adversarial providers that lie or fabricate evidence, contention and volume, clock skew between issuer and consumer, and a structurally opposite append-only provider. 65 tests, up from 43.

## 0.3.0

First release published to npm, and the first release with a general-purpose API.

### Added

- `TransactionEngine`, generic over an `EffectAdapter`. The engine owns transaction semantics and knows nothing about any provider.
- `defineEffect`, which builds an adapter from a small operation description. It implements canonical payload hashing, witness capture, material-field diffing, the pre-dispatch freshness re-check, reconciliation, verification, and safe-compensation checks once, so a definition supplies only provider knowledge.
- `finalize`: downstream work run after the effect is verified and before the transaction is declared committed. If it throws, the verified effect is compensated — unless doing so would overwrite state the transaction does not own.
- `normalizeState`, for provider representations that carry no meaning. Without it an unordered array reads as a material change and dispatches a write that changes nothing.
- A `zerogate` CLI: `receipt verify`, `contract digest`, and `keys new`.
- `ABORTED` as a terminal outcome. A stale witness now produces a signed receipt proving nothing was dispatched, instead of throwing.
- `providerRequestIds` on `Reconciliation`, so the request that actually committed is recorded in the receipt.
- A credential guard: a value shaped like a PEM private key, GitHub or npm token, AWS key ID, JWT, or bearer token in a recorded field refuses the transaction during preflight, before anything is dispatched. It matches shapes only, so prose mentioning "password" is never blocked.
- Schema tests that validate real engine output against the published JSON Schemas in `schemas/`, so those schemas cannot drift from what the engine emits.
- A package smoke test that packs the tarball npm would publish, installs it into a scratch project, and uses both the library and the installed binary.

### Changed

- Licensed under Apache-2.0. The previous all-rights-reserved notice made distribution meaningless.
- The documentation site is a static Next.js application deployed to Vercel, with no database and no environment variables.
- Errors from a read are reported as safe to retry rather than as an unknown outcome. A read never mutates anything.

### Removed

- `redactPaths`, which was exported but wired into nothing. Redaction happens through `redactFields`, which hashes the value so the diff stays verifiable.
- `assertTransactionTransition`, `assertActionTransition`, `sha256`, `toJsonValue`, and `canonicalEventTime` from the public API. They are internals, and a smaller surface is a simpler one.
- The fixed set of demo scenarios and the simulator hooks the engine reached into to stage them. Outcomes are now produced by providers genuinely misbehaving, which is also how they are tested.
- The bespoke GitHub adapter. Its semantics are now general, in `defineEffect`.
- A generic SDK and gateway proxy that failed closed without doing anything.
- The waitlist, its database, the recorded simulator, and the marketing pages.

### Fixed

- Array-order sensitivity in material-field comparison, which treated a no-op reorder as a change and dispatched a pointless write.
- A CSS specificity defect that painted the site's header call to action in dark ink on a dark ground, making the label invisible.
