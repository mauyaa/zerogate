# 0002. A provider's response is evidence; authoritative state is proof

**Status:** Accepted

## Context

Providers report success while writing nothing, fabricate records for
operations that never committed, and contradict themselves between reads.
A system that trusts the response it received inherits every one of those
failures and reports them as success.

## Decision

Outcomes carry a finality level that states how they are known:

| Finality | Meaning |
| --- | --- |
| `VERIFIED` | Authoritative state was re-read and matches the approved postcondition |
| `PROVIDER_ATTESTED` | Only the provider's own record confirms it |
| `UNKNOWN` | Nothing confirms it |
| `DISPUTED` | The evidence disagrees with itself |

`VERIFIED_COMMITTED` requires the post-dispatch observation of authoritative
state to match the expected material fields. A success response alone never
reaches it.

## Alternatives considered

- **Trust a 2xx response.** Fast, and the root of the failures above.
- **Binary success/failure.** Loses the distinction between "proved" and
  "claimed", which is the information an operator needs in an incident.

## Consequences

- An extra read after every dispatch.
- The adversarial suite asserts that no provider behaviour, including
  fabricated evidence and reverting after verification, can produce a
  `VERIFIED_COMMITTED` receipt unless state genuinely matches.
