# Contributing to ZeroGate

ZeroGate is Apache-2.0 licensed and maintained by one person. The core promise — that a side effect is either proven or honestly reported as unresolved — takes priority over feature breadth.

## Rules that are not negotiable

These are the invariants the library exists to provide. A change that breaks one is a bug even if every test passes.

1. **Never claim what the code does not support.** If a guarantee is conditional, state the condition in the same sentence. The [limits](docs/README.md#limits) are part of the product, not a disclaimer.
2. **Never guess an outcome.** When a dispatch's result is unknown it is `OUTCOME_UNKNOWN`. Reporting it as failure causes duplicate effects; reporting it as success causes silent data loss.
3. **Do not infer commitment from state.** Reconciliation requires provider-side evidence keyed by the logical operation ID. Matching state proves nothing, because anything else could have produced it.
4. **A provider's success response is evidence, not proof.** Always verify against authoritative state.
5. **Compensation may be refused.** If a material field no longer matches what the forward effect produced, do not overwrite it.
6. **The engine owns transaction semantics; adapters own provider knowledge.** Nothing provider-specific belongs in `src/core/transaction-engine.ts`, and no retry, approval, or compensation policy belongs in an effect definition.
7. **Secrets never enter evidence.** Use `redactFields`. Receipts carry hashes, not values.

## Before opening a change

- Report vulnerabilities through GitHub's private advisory flow, never in a public issue. See [SECURITY.md](SECURITY.md).
- Keep proposals inside the intent-to-recovery lifecycle. Identity, billing, workflow orchestration, model gateways, and marketplaces are out of scope.
- Read `src/core/adapter.ts` first if you are touching the core. Its doc comments state the four rules an adapter must obey, and it is the seam that keeps the engine provider-agnostic.
- If a change makes any guarantee weaker, say so explicitly in the pull request rather than leaving review to notice.

## Changes that need extra care

- **Public schemas** in `schemas/` and the receipt body — third-party verifiers consume these.
- **State machine transitions** in `src/core/state-machine.ts` — a new transition can create a terminal state the evidence does not justify.
- **Effect contract digests** — changing a contract invalidates approvals bound to it. That is intended; do not work around it.
- **Migrations** — append only. The runner checksums them, and an edited migration will be rejected.

## Local validation

Node.js 22 or newer.

```bash
npm ci
npm run validate
```

That runs ESLint, strict TypeScript, the full test suite, the build, and a real install of the packed tarball into a scratch project. The last step is the only one that can catch a broken `exports` map or `files` list.

The site has its own lockfile and gate:

```bash
cd site
npm ci
npm run validate
```

PostgreSQL ledger tests are skipped unless a database is available:

```bash
npm run db:up
ZEROGATE_TEST_ADMIN_DATABASE_URL=postgresql://postgres:zerogate@127.0.0.1:5432/postgres npm run test:postgres
```

## Tests

New behaviour needs a test that would fail without it. For anything touching transaction semantics, that means a test against the example HTTP service in `examples/rest-resource` — a real server over a real socket, with the provider genuinely misbehaving. Do not add a test that stages an outcome by telling the engine which ending to perform; the previous version of this project did that, and it hid real defects.

## Releasing

Tagging is the whole process:

```bash
npm version minor          # or patch / major
git push --follow-tags
```

The `release` workflow then validates both packages, runs the PostgreSQL proof against a real server, builds a source archive and the npm tarball, generates an SPDX SBOM, attests every artifact, and creates the GitHub release.

It also publishes to npm **with a provenance attestation**, so the published tarball is cryptographically linked to the workflow run and commit that produced it. That step needs an `NPM_TOKEN` repository secret — an npm granular access token with publish rights to `zerogate`. Without the secret the step is skipped and the release is still produced, so nothing fails; you just publish nothing.

Publishing from CI is preferred over a local `npm publish`, because a local publish carries no provenance.

## Pull requests

Keep them small, and explain:

- the invariant or requirement implemented;
- schema, migration, and receipt impact;
- the failure the new test reproduces; and
- anything that is now less true than it was.

A passing build is required. It is not, by itself, evidence that a safety claim holds.
