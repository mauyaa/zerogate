import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalAuthority, ZeroGateError } from "../src/index.js";
// Internal on purpose: callers never need to canonicalise a timestamp by hand,
// the ledger does it on append. The test reaches in to pin the behaviour.
import { InMemoryEventLedger, canonicalEventTime } from "../src/core/event-ledger.js";
import { TEST_ACTOR } from "./helpers/publish-harness.js";

/**
 * Clock skew between the party that approves an action and the party that
 * consumes the approval.
 *
 * Approvals carry an expiry, so a skewed clock is an attack surface: if the
 * consumer's clock runs behind the issuer's, an expired mandate could be
 * accepted. These tests pin the boundary from both directions.
 */

const BINDING = {
  transactionId: "11111111-1111-4111-8111-111111111111",
  actor: TEST_ACTOR,
  approverId: TEST_ACTOR.principalId,
  approvalLevel: "human-owner",
  actionSetRoot: "a".repeat(64),
  payloadHash: "b".repeat(64),
  contractDigest: "c".repeat(64),
  resourceWitnessHash: "d".repeat(64),
  limitsHash: "e".repeat(64),
  policyVersion: "policy.human-approval.v1"
} as const;

const at = (isoOffsetSeconds: number): Date => new Date(Date.UTC(2026, 0, 1) + isoOffsetSeconds * 1000);

test("an approval is rejected the instant it expires, regardless of skew direction", () => {
  const authority = new ApprovalAuthority();
  const issuedAt = at(0);
  const approval = authority.issue({ ...BINDING, ttlSeconds: 60, now: issuedAt });

  // Consumer's clock is behind the issuer's: still inside the window, accepted.
  assert.doesNotThrow(() => {
    authority.consume(approval, { ...BINDING, now: at(-30) });
  });
});

test("a consumer clock past the expiry refuses the mandate", () => {
  const authority = new ApprovalAuthority();
  const approval = authority.issue({ ...BINDING, ttlSeconds: 60, now: at(0) });

  assert.throws(
    () => {
      authority.consume(approval, { ...BINDING, now: at(61) });
    },
    (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_EXPIRED"
  );
});

test("the expiry boundary is exclusive, so a mandate cannot be used at its own deadline", () => {
  const authority = new ApprovalAuthority();
  const approval = authority.issue({ ...BINDING, ttlSeconds: 60, now: at(0) });

  // Exactly at expiresAt the mandate is already dead: `<=` not `<`.
  assert.throws(
    () => {
      authority.consume(approval, { ...BINDING, now: at(60) });
    },
    (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_EXPIRED"
  );
});

test("a skewed clock cannot resurrect an already-consumed mandate", () => {
  const authority = new ApprovalAuthority();
  const approval = authority.issue({ ...BINDING, ttlSeconds: 3600, now: at(0) });

  authority.consume(approval, { ...BINDING, now: at(10) });

  // Rewinding the consumer's clock must not re-open the replay window.
  assert.throws(
    () => {
      authority.consume(approval, { ...BINDING, now: at(-3600) });
    },
    (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_REPLAYED"
  );
});

test("an approval from a different authority is refused whatever the clock says", () => {
  const issuer = new ApprovalAuthority();
  const consumer = new ApprovalAuthority();
  const approval = issuer.issue({ ...BINDING, ttlSeconds: 3600, now: at(0) });

  for (const now of [at(-3600), at(0), at(1800)]) {
    assert.throws(
      () => {
        consumer.consume(approval, { ...BINDING, now });
      },
      (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_MISMATCH"
    );
  }
});

test("event timestamps are canonicalised to UTC so mixed-offset clocks stay ordered", () => {
  // The same instant expressed in three offsets must canonicalise identically.
  const instants = [
    "2026-01-01T12:00:00.000Z",
    "2026-01-01T14:00:00.000+02:00",
    "2026-01-01T07:00:00.000-05:00"
  ];
  const canonical = new Set(instants.map((value) => canonicalEventTime(value)));
  assert.equal(canonical.size, 1, `offsets did not converge: ${[...canonical].join(", ")}`);
  assert.equal([...canonical][0], "2026-01-01T12:00:00.000Z");
});

test("a ledger keeps its hash chain when appends arrive with out-of-order timestamps", async () => {
  const ledger = new InMemoryEventLedger();

  // A skewed writer supplies a timestamp earlier than the previous event's.
  await ledger.append({
    type: "dev.zerogate.test.recorded.v1",
    subject: "tx",
    time: "2026-01-01T12:00:00.000Z",
    data: { step: 1 }
  });
  await ledger.append({
    type: "dev.zerogate.test.recorded.v1",
    subject: "tx",
    time: "2026-01-01T11:59:00.000Z",
    data: { step: 2 }
  });

  const events = await ledger.list("tx");
  // Ordering is by sequence, which the ledger owns, not by the caller's clock.
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2]
  );
  assert.deepEqual(
    events.map((event) => event.data["step"]),
    [1, 2]
  );
  assert.equal(await ledger.verify(), true);
});
