import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { sha256 } from "./canonical-json.js";

export interface KeyPairPem {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export class KeyStore {
  readonly #keyDir: string | undefined;

  public constructor(keyDir?: string) {
    this.#keyDir = keyDir;
  }

  public getOrCreateKeyPair(name: string, envVarName?: string): KeyPairPem {
    if (envVarName) {
      const envVal = process.env[envVarName];
      if (typeof envVal === "string" && envVal.length > 0) {
        const privKey = createPrivateKey(envVal);
        const pubKey = createPublicKey(privKey);
        const pubPem = pubKey.export({ type: "spki", format: "pem" }).toString();
        const keyId = `ed25519:${sha256(pubPem).slice(0, 24)}`;
        return { keyId, privateKeyPem: envVal, publicKeyPem: pubPem };
      }
    }

    if (this.#keyDir) {
      const filePath = join(this.#keyDir, `${name}.pem`);
      if (existsSync(filePath)) {
        const pem = readFileSync(filePath, "utf-8");
        const privKey = createPrivateKey(pem);
        const pubKey = createPublicKey(privKey);
        const pubPem = pubKey.export({ type: "spki", format: "pem" }).toString();
        const keyId = `ed25519:${sha256(pubPem).slice(0, 24)}`;
        return { keyId, privateKeyPem: pem, publicKeyPem: pubPem };
      }
    }

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const keyId = `ed25519:${sha256(pubPem).slice(0, 24)}`;

    if (this.#keyDir) {
      mkdirSync(this.#keyDir, { recursive: true });
      writeFileSync(join(this.#keyDir, `${name}.pem`), privPem, "utf-8");
      writeFileSync(join(this.#keyDir, `${name}.pub.pem`), pubPem, "utf-8");
    }

    return { keyId, privateKeyPem: privPem, publicKeyPem: pubPem };
  }
}
