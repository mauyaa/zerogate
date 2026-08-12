import { createHash } from "node:crypto";
import { ZeroGateError } from "./errors.js";
import type { JsonValue } from "./types.js";

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ZeroGateError(
          "INVALID_CANONICAL_JSON",
          `Lone high surrogate at ${path}`,
          false
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ZeroGateError("INVALID_CANONICAL_JSON", `Lone low surrogate at ${path}`, false);
    }
  }
}

function assertJsonValue(value: unknown, path = "$", seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertValidUnicode(value, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new ZeroGateError(
        "INVALID_CANONICAL_JSON",
        `Non-I-JSON number at ${path}: ${String(value)}`,
        false
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new ZeroGateError("INVALID_CANONICAL_JSON", `Cycle at ${path}`, false);
    }
    seen.add(value);
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new ZeroGateError("INVALID_CANONICAL_JSON", `Cycle at ${path}`, false);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ZeroGateError(
        "INVALID_CANONICAL_JSON",
        `Only plain JSON objects are supported at ${path}`,
        false
      );
    }
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      assertValidUnicode(key, `${path}.{key}`);
      if (child === undefined) {
        throw new ZeroGateError(
          "INVALID_CANONICAL_JSON",
          `Undefined is not allowed at ${path}.${key}`,
          false
        );
      }
      assertJsonValue(child, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw new ZeroGateError(
    "INVALID_CANONICAL_JSON",
    `Unsupported value at ${path}: ${typeof value}`,
    false
  );
}

function compareUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort(compareUtf16);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key]!)}`).join(",")}}`;
}

/**
 * RFC 8785 JSON Canonicalization Scheme with verified errata applied.
 * Semantic normalization must happen before this function; JCS itself preserves strings as-is.
 */
export function canonicalize(value: unknown): string {
  assertJsonValue(value);
  return serialize(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return `sha256:${sha256(canonicalize(value))}`;
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalize(value)) as JsonValue;
}
