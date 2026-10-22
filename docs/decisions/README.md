# Architecture decisions

Short records of the decisions that shape ZeroGate: the context, what was
chosen, what was rejected, and what it costs. They were recorded on
2026-10-22, after the decisions were made, from the code and the reference
docs as they stand.

| # | Decision |
| --- | --- |
| [0001](0001-outcome-unknown-not-failure.md) | A lost response is `OUTCOME_UNKNOWN`, resolved by reconciliation, never by retrying |
| [0002](0002-evidence-versus-proof.md) | A provider's response is evidence; authoritative state is proof |
| [0003](0003-material-fields-and-guarded-compensation.md) | Effects own only declared fields; compensation is a guarded forward write |
| [0004](0004-payload-bound-approval.md) | Approval binds to the exact payload and the observed state version |
| [0005](0005-signed-receipts-over-event-chain.md) | Every outcome ends in a signed receipt over a hash-linked event chain |
| [0006](0006-zero-runtime-dependencies.md) | No runtime dependencies; PostgreSQL is an optional peer |
| [0007](0007-no-automatic-crash-resume.md) | An interrupted transaction is not resumed automatically |

New decisions get the next number. A superseded record stays in place with
its status changed and a link to its replacement.
