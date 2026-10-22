# 0004. Approval binds to the exact payload and the observed state version

**Status:** Accepted

## Context

An approval granted for one change must not authorise a different one, and
a preview approved against old state must not be applied to new state. Both
happen when approval is a boolean flag or a role check.

## Decision

`ApprovalAuthority` issues single-use mandates bound to a hash of the exact
payload and to the witness: the authoritative state, with its version marker,
observed while building the preview. Immediately before dispatch the engine
re-reads the state. If the version moved, the transaction ends `ABORTED` and
nothing is sent. A mandate that does not match the payload ends
`APPROVAL_DENIED`.

## Alternatives considered

- **Role-based authorisation only.** Authorises the actor, not the change.
- **Approve and apply later without re-reading.** Applies a preview that may
  no longer describe reality.

## Consequences

- The freshness check narrows the race between approval and write but does
  not close it. Effects should also use a provider-side conditional write,
  such as `If-Match`, where one exists.
- Consumed nonces live in process memory. A restart or a second instance
  will accept a mandate that was already used, so multi-instance deployments
  must back replay protection with shared storage. This is listed under
  Limits in the reference.
