/**
 * Refuses to put credentials into evidence.
 *
 * Receipts are meant to be shared — with auditors, with support, with anyone
 * verifying an outcome — so a token that reaches one is disclosed to everybody
 * who ever reads it. This guard runs before anything is dispatched, so failing
 * here costs nothing.
 *
 * The patterns match credential *shapes* only, never words like "password" or
 * "secret". A document titled "Password reset" is ordinary content, and a guard
 * that blocked it would be turned off within a week.
 */

interface CredentialPattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { kind: "PEM private key", pattern: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/ },
  { kind: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { kind: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { kind: "AWS access key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i },
  { kind: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ }
];

/**
 * Returns a description of the credential shape found, or `undefined` when the
 * value looks like ordinary content.
 */
export function findCredentialShape(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return undefined;
}
