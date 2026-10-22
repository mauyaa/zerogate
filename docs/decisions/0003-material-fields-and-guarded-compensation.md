# 0003. Effects own only declared fields; compensation is a guarded forward write

**Status:** Accepted

## Context

Undoing a committed effect after a downstream failure is where most saga
implementations corrupt data. Restoring a whole record overwrites changes
other actors made in the meantime, and a provider rarely offers a true
rollback.

## Decision

Each effect declares `materialFields`, the fields it claims ownership of.
Only those are diffed, verified and restored; the rest of the record is out
of scope.

Compensation is a new forward write that restores the material fields to
their pre-dispatch values. Before sending it, the engine checks that every
material field still equals the value this transaction wrote. If any has
moved, compensation is refused with a message naming the field, and the
transaction ends in manual recovery instead of overwriting newer state.

## Alternatives considered

- **Restore the full previous record.** Silently erases concurrent edits.
- **Rely on provider rollback.** Rarely available, and its semantics vary
  between providers.

## Consequences

- Compensation is safe to reason about field by field, and verifiable the
  same way as the forward effect.
- Some compensations are refused and need a human. The refusal is the
  correct outcome when the alternative is destroying someone else's write.
- An effect that declares no compensating operation is never auto-undone.
