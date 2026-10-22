# 0006. No runtime dependencies; PostgreSQL is an optional peer

**Status:** Accepted

## Context

ZeroGate sits on the path of payments and other irreversible writes. Every
runtime dependency is code that runs on that path and supply-chain surface
that has to be audited and patched.

## Decision

The published package has no runtime dependencies. Hashing, signing and
UUIDs come from `node:crypto`; canonical JSON is implemented in the package.
The PostgreSQL ledger is a separate entry point, `zerogate/postgres`, with
`pg` declared as an optional peer dependency.

## Consequences

- Installing the core pulls in nothing else.
- Canonical JSON and the ledgers are maintained here rather than borrowed,
  so they carry their own tests.
- Node.js 22 or later is required for the built-in APIs used.
