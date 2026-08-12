import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalAuthority } from "../src/core/approval.js";
import { ZeroGateError } from "../src/core/errors.js";

const actor = {
  principalId: "user_1",
  agentId: "agent_1",
  agentVersion: "1.0.0"
};
const binding = {
  transactionId: "tx_1",
  actor,
  approverId: "user_1",
  approvalLevel: "human-owner",
  actionSetRoot: "sha256:root",
  payloadHash: "sha256:payload",
  contractDigest: "sha256:contract",
  resourceWitnessHash: "sha256:witness",
  limitsHash: "sha256:limits",
  policyVersion: "policy.v1"
};

test("approval is bound to the complete transaction and action admission context", () => {
  const authority = new ApprovalAuthority();
  const approval = authority.issue({ ...binding, ttlSeconds: 60 });
  assert.throws(
    () => authority.consume(approval, { ...binding, resourceWitnessHash: "sha256:changed" }),
    (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_MISMATCH"
  );
  assert.throws(
    () => authority.consume(approval, { ...binding, policyVersion: "policy.v2" }),
    (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_MISMATCH"
  );
});

test("approval is single-use", () => {
  const authority = new ApprovalAuthority();
  const approval = authority.issue({ ...binding, ttlSeconds: 60 });
  authority.consume(approval, binding);
  assert.throws(
    () => authority.consume(approval, binding),
    (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_REPLAYED"
  );
});

test("expired approval is rejected", () => {
  const authority = new ApprovalAuthority();
  const issuedAt = new Date("2026-01-01T00:00:00.000Z");
  const approval = authority.issue({ ...binding, ttlSeconds: 30, now: issuedAt });
  assert.throws(
    () =>
      authority.consume(approval, {
        ...binding,
        now: new Date("2026-01-01T00:00:31.000Z")
      }),
    (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_EXPIRED"
  );
});

test("tampered approval claims fail signature verification", () => {
  const authority = new ApprovalAuthority();
  const approval = authority.issue({ ...binding, ttlSeconds: 60 });
  const tampered = structuredClone(approval);
  tampered.claims.payloadHash = "sha256:tampered";
  assert.throws(
    () => authority.consume(tampered, { ...binding, payloadHash: "sha256:tampered" }),
    (error: unknown) => error instanceof ZeroGateError && error.code === "APPROVAL_MISMATCH"
  );
});
