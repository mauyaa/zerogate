# 0001. A lost response is OUTCOME_UNKNOWN, never a failure

**Status:** Accepted

## Context

A request leaves the process and the connection drops before an answer
arrives. The provider may have committed the change or never received it.
Most clients collapse this into "failed" and either retry, which can apply
the effect twice, or give up, which can abandon an effect that already
happened. Both are wrong half the time, and for payments and publishing both
halves are expensive.

## Decision

A dispatch whose answer was lost ends in an explicit `OUTCOME_UNKNOWN`
state, not an error. The engine then reconciles: it asks the provider what
committed, keyed by a stable logical operation ID that was sent as the
idempotency key or client reference. Only evidence resolves the state. There
is no retry path out of `OUTCOME_UNKNOWN`.

If reconciliation cannot decide, the transaction ends in
`MANUAL_RECOVERY_REQUIRED` with `UNKNOWN` finality and says so in its receipt.

## Alternatives considered

- **Retry with an idempotency key.** Safe only when the provider honours the
  key for the whole retry window, which callers usually cannot verify. Kept
  as a property the effect can use, not as the recovery mechanism.
- **Treat timeouts as failure.** Simple, and wrong whenever the write landed.

## Consequences

- At most one verified effect per approved payload, but not exactly-once
  delivery; nothing provides that across a network.
- Every effect must implement `findEvidence`. An effect whose provider
  offers no way to look up an operation cannot resolve an unknown outcome,
  and the testing suite fails such an effect deliberately.
- Some transactions end in manual recovery. That is the honest answer when
  the evidence is missing, and the receipt records it.
