import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import { canonicalize, sha256 } from "./canonical-json.js";
import type { ReceiptBody, SignedReceipt } from "./types.js";

export class ReceiptSigner {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
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

  public static fromPem(privateKeyPem: string): ReceiptSigner {
    return new ReceiptSigner(createPrivateKey(privateKeyPem));
  }

  public publicKeyPem(): string {
    return this.#publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  public privateKeyPem(): string {
    return this.#privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  public sign(body: Omit<ReceiptBody, "receiptId" | "issuedAt"> & Partial<Pick<ReceiptBody, "receiptId" | "issuedAt">>, eventChainRoot: string): SignedReceipt {
    const receiptBody: ReceiptBody = {
      ...body,
      receiptId: body.receiptId ?? randomUUID(),
      issuedAt: body.issuedAt ?? new Date().toISOString()
    };
    const integrityClaims = {
      algorithm: "Ed25519" as const,
      keyId: this.keyId,
      eventChainRoot
    };
    const signature = sign(
      null,
      Buffer.from(canonicalize({ ...receiptBody, integrity: integrityClaims })),
      this.#privateKey
    ).toString("base64url");
    return {
      ...receiptBody,
      integrity: {
        ...integrityClaims,
        signature
      }
    };
  }
}

export function verifyReceipt(receipt: unknown, publicKeyPem: string): boolean {
  try {
    if (!isRecord(receipt)) return false;
    const integrity = receipt["integrity"];
    if (!isRecord(integrity)) return false;
    const signature = integrity["signature"];
    const algorithm = integrity["algorithm"];
    const keyId = integrity["keyId"];
    const eventChainRoot = integrity["eventChainRoot"];
    if (
      typeof signature !== "string" ||
      algorithm !== "Ed25519" ||
      typeof keyId !== "string" ||
      typeof eventChainRoot !== "string"
    ) {
      return false;
    }

    const { integrity: _integrity, ...body } = receipt;
    const integrityClaims = { algorithm, keyId, eventChainRoot };
    const publicKey = createPublicKey(publicKeyPem);
    const normalizedPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
    const expectedKeyId = `ed25519:${sha256(normalizedPublicKey).slice(0, 24)}`;
    if (keyId !== expectedKeyId) return false;
    return verify(
      null,
      Buffer.from(canonicalize({ ...body, integrity: integrityClaims })),
      publicKey,
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
