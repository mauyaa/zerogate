# 0005. Every outcome ends in a signed receipt over a hash-linked event chain

**Status:** Accepted

## Context

After an incident, the question is what actually happened and whether the
record of it can be trusted. Application logs answer the first loosely and
the second not at all: anyone with write access can edit them.

## Decision

Each transaction appends to an event ledger in which every event is
hash-linked to the previous one. Every terminal outcome, including refusals,
produces a receipt: an Ed25519 signature, using `node:crypto`, over a
canonical JSON body that covers the intent binding, the action, the ordered
observations, the residual risk and the root of the event chain.

Verification requires both checks: the signature against the public key,
and re-deriving the chain root from the events. A valid signature alone only
proves the body was signed.

## Alternatives considered

- **Structured logs.** Not tamper-evident.
- **An external transparency log.** Stronger, but a hard dependency on
  infrastructure most users do not run.

## Consequences

- Receipts can be verified offline with `zerogate receipt verify`.
- Without a retained key the engine signs with an ephemeral keypair, which
  makes receipts unverifiable after the process exits. The engine warns
  unless `"ephemeral"` is chosen explicitly, because a silently unverifiable
  receipt is the version of this mistake that reaches production.
- Values shaped like credentials are refused in preflight so they cannot be
  sealed into a receipt.
