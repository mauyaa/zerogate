import type { JsonValue } from "./types.js";

const SECRET_PATTERN = /(bearer\s+[a-z0-9._~+/=-]+|gh[pousr]_[a-z0-9_]+|api[_-]?key|password|secret)/i;

export function redactPaths(value: JsonValue, paths: readonly string[]): JsonValue {
  const cloned = structuredClone(value);
  for (const path of paths) {
    const parts = path.split(".").filter(Boolean);
    let cursor: JsonValue = cloned;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (Array.isArray(cursor) || cursor === null || typeof cursor !== "object") break;
      const next = cursor[parts[index]!];
      if (next === undefined) break;
      cursor = next;
    }
    if (!Array.isArray(cursor) && cursor !== null && typeof cursor === "object") {
      const leaf = parts.at(-1);
      if (leaf !== undefined && leaf in cursor) cursor[leaf] = "[REDACTED]";
    }
  }
  return cloned;
}

export function containsLikelySecret(value: unknown): boolean {
  return SECRET_PATTERN.test(JSON.stringify(value));
}
