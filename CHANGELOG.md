# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
