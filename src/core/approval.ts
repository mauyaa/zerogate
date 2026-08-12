import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import { canonicalize, hashCanonical, sha256 } from "./canonical-json.js";
import { ZeroGateError } from "./errors.js";
import type { Actor } from "./types.js";

export interface ApprovalClaims {
  approvalId: string;
  nonce: string;
  transactionId: string;
  actor: Actor;
  approverId: string;
  approvalLevel: string;
  actionSetRoot: string;
  payloadHash: string;
  contractDigest: string;
  resourceWitnessHash: string;
  limitsHash: string;
  policyVersion: string;
  expiresAt: string;
  issuedAt: string;
}

export interface SignedApproval {
  claims: ApprovalClaims;
  algorithm: "Ed25519";
  keyId: string;
  signature: string;
}

export class ApprovalAuthority {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #usedNonces = new Set<string>();
  public readonly keyId: string;

  public constructor(privateKey?: KeyObject) {
    if (privateKey === undefined) {
      const pair = generateKeyPairSync("ed25519");
      this.#privateKey = pair.privateKey;
      this.#publicKey = pair.publicKey;
    } else {
      this.#privateKey = privateKey;
      this.#publicKey = createPublicKey(privateKey);
    }
    this.keyId = `ed25519:${sha256(this.publicKeyPem()).slice(0, 24)}`;
  }

  public static fromPem(privateKeyPem: string): ApprovalAuthority {
    return new ApprovalAuthority(createPrivateKey(privateKeyPem));
  }

  public publicKeyPem(): string {
    return this.#publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  public issue(input: {
    transactionId: string;
    actor: Actor;
    approverId: string;
    approvalLevel: string;
    actionSetRoot: string;
    payloadHash: string;
    contractDigest: string;
    resourceWitnessHash: string;
    limitsHash: string;
    policyVersion: string;
    ttlSeconds: number;
    now?: Date;
  }): SignedApproval {
    const now = input.now ?? new Date();
    const claims: ApprovalClaims = {
      approvalId: randomUUID(),
      nonce: randomUUID(),
      transactionId: input.transactionId,
      actor: input.actor,
      approverId: input.approverId,
      approvalLevel: input.approvalLevel,
      actionSetRoot: input.actionSetRoot,
      payloadHash: input.payloadHash,
      contractDigest: input.contractDigest,
      resourceWitnessHash: input.resourceWitnessHash,
      limitsHash: input.limitsHash,
      policyVersion: input.policyVersion,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString()
    };
    const signature = sign(null, Buffer.from(canonicalize(claims)), this.#privateKey).toString("base64url");
    return { claims, algorithm: "Ed25519", keyId: this.keyId, signature };
  }

  public consume(
    approval: SignedApproval,
    expected: {
      transactionId: string;
      actor: Actor;
      approverId: string;
      approvalLevel: string;
      actionSetRoot: string;
      payloadHash: string;
      contractDigest: string;
      resourceWitnessHash: string;
      limitsHash: string;
      policyVersion: string;
      now?: Date;
    }
  ): void {
    if (approval.algorithm !== "Ed25519" || approval.keyId !== this.keyId) {
      throw new ZeroGateError("APPROVAL_MISMATCH", "Unknown approval authority", false);
    }
    const validSignature = verify(
      null,
      Buffer.from(canonicalize(approval.claims)),
      this.#publicKey,
      Buffer.from(approval.signature, "base64url")
    );
    if (!validSignature) {
      throw new ZeroGateError("APPROVAL_MISMATCH", "Approval signature is invalid", false);
    }
    if (this.#usedNonces.has(approval.claims.nonce)) {
      throw new ZeroGateError("APPROVAL_REPLAYED", "Approval has already been consumed", false);
    }
    const now = expected.now ?? new Date();
    if (new Date(approval.claims.expiresAt).getTime() <= now.getTime()) {
      throw new ZeroGateError("APPROVAL_EXPIRED", "Approval has expired", false);
    }
    const expectedBinding = {
      transactionId: expected.transactionId,
      actor: expected.actor,
      approverId: expected.approverId,
      approvalLevel: expected.approvalLevel,
      actionSetRoot: expected.actionSetRoot,
      payloadHash: expected.payloadHash,
      contractDigest: expected.contractDigest,
      resourceWitnessHash: expected.resourceWitnessHash,
      limitsHash: expected.limitsHash,
      policyVersion: expected.policyVersion
    };
    const actualBinding = {
      transactionId: approval.claims.transactionId,
      actor: approval.claims.actor,
      approverId: approval.claims.approverId,
      approvalLevel: approval.claims.approvalLevel,
      actionSetRoot: approval.claims.actionSetRoot,
      payloadHash: approval.claims.payloadHash,
      contractDigest: approval.claims.contractDigest,
      resourceWitnessHash: approval.claims.resourceWitnessHash,
      limitsHash: approval.claims.limitsHash,
      policyVersion: approval.claims.policyVersion
    };
    if (hashCanonical(expectedBinding) !== hashCanonical(actualBinding)) {
      throw new ZeroGateError(
        "APPROVAL_MISMATCH",
        "Approval is not bound to the exact current action set",
        false
      );
    }
    this.#usedNonces.add(approval.claims.nonce);
  }
}
