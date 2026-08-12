import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, hashCanonical } from "../src/core/canonical-json.js";
import { ZeroGateError } from "../src/core/errors.js";

function shuffledObject(entries: Array<[string, unknown]>): Record<string, unknown> {
  const copy = [...entries];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return Object.fromEntries(copy);
}

test("canonical JSON is deterministic across object insertion order", () => {
  const entries: Array<[string, unknown]> = [
    ["z", 3],
    ["a", { q: true, b: [3, 2, 1] }],
    ["unicode", "é"],
    ["null", null]
  ];
  const expected = hashCanonical(Object.fromEntries(entries));
  for (let iteration = 0; iteration < 250; iteration += 1) {
    assert.equal(hashCanonical(shuffledObject(entries)), expected);
  }
});

test("canonical JSON sorts recursively and preserves array order", () => {
  assert.equal(
    canonicalize({ b: 1, a: [{ z: 2, y: 1 }, 3] }),
    '{"a":[{"y":1,"z":2},3],"b":1}'
  );
});

test("canonical JSON rejects negative zero according to verified RFC 8785 errata", () => {
  assert.throws(
    () => canonicalize({ value: -0 }),
    (error: unknown) => error instanceof ZeroGateError && error.code === "INVALID_CANONICAL_JSON"
  );
});

test("canonical JSON rejects cycles and lone surrogates", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.throws(() => canonicalize(cyclic), ZeroGateError);
  assert.throws(() => canonicalize({ invalid: "\ud800" }), ZeroGateError);
});
