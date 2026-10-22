# 0007. An interrupted transaction is not resumed automatically

**Status:** Accepted, revisit before 1.0

## Context

A process can die between dispatch and verification. The durable ledgers
record everything up to that point. Resuming automatically on startup would
mean re-entering a transaction whose external state may have changed while
nothing was watching.

## Decision

The engine does not resume interrupted transactions. A durable ledger keeps
the event history, and recovery is an explicit operator action.

## Alternatives considered

- **Resume on startup.** Convenient, but an automatic re-entry is the riskiest
  moment for exactly the double-apply bug this project exists to prevent, and
  it needs its own reconciliation-first design and tests.

## Consequences

- Operators must find and resolve interrupted transactions themselves.
- Listed under "What is still not verified" in the reference. A
  reconciliation-only resume, which never re-dispatches, is the likely design
  when this is revisited.
