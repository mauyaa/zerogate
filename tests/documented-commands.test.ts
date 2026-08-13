import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Documentation that names an environment variable or script wrongly is worse
 * than documentation that names none: the PostgreSQL suite skips silently
 * without its variable, so a typo in the README reads as a passing run. The
 * README did carry that exact typo, which is why these checks exist.
 */

const root = new URL("../../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, root), "utf8");

test("every environment variable the docs name is one the code reads", async () => {
  const [test_, readme, contributing, ci, release] = await Promise.all([
    read("tests/postgres-event-ledger.test.ts"),
    read("README.md"),
    read("CONTRIBUTING.md"),
    read(".github/workflows/ci.yml"),
    read(".github/workflows/release.yml")
  ]);

  const readByCode = new Set(
    [...test_.matchAll(/process\.env\["([A-Z0-9_]+)"\]/g)].map(([, name]) => name)
  );
  assert.ok(readByCode.size > 0, "expected the suite to read at least one variable");

  // Any ZEROGATE_*ADMIN* name mentioned anywhere must be one the code reads.
  for (const [source, text] of [
    ["README.md", readme],
    ["CONTRIBUTING.md", contributing],
    [".github/workflows/ci.yml", ci],
    [".github/workflows/release.yml", release]
  ] as const) {
    for (const [, name] of text.matchAll(/\b(ZEROGATE_[A-Z0-9_]*ADMIN[A-Z0-9_]*)\b/g)) {
      assert.ok(
        readByCode.has(name),
        `${source} names ${name}, but the test reads ${[...readByCode].join(", ")}`
      );
    }
  }
});

test("every npm script the docs invoke exists in package.json", async () => {
  const manifest = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
  const scripts = new Set(Object.keys(manifest.scripts));

  for (const path of ["README.md", "CONTRIBUTING.md", "docs/README.md"]) {
    const text = await read(path);
    for (const [, script] of text.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) {
      if (script === undefined) continue;
      assert.ok(scripts.has(script), `${path} invokes 'npm run ${script}', which is not defined`);
    }
  }
});

test("every CLI command the docs invoke is one the CLI accepts", async () => {
  const cli = await read("src/cli/main.ts");
  const documented = new Set<string>();

  for (const path of ["README.md", "docs/README.md"]) {
    const text = await read(path);
    for (const [, command] of text.matchAll(/npx zerogate ([a-z]+(?: [a-z]+)?)/g)) {
      if (command !== undefined) documented.add(command.trim());
    }
  }

  assert.ok(documented.size > 0, "expected the docs to show at least one CLI command");
  for (const command of documented) {
    const parts = command.split(" ");
    const group = parts[0];
    const sub = parts[1];
    if (group === undefined) continue;
    assert.match(cli, new RegExp(`"${group}"`), `the CLI has no '${group}' command`);
    if (sub !== undefined) {
      assert.match(cli, new RegExp(`"${sub}"`), `the CLI has no '${group} ${sub}' subcommand`);
    }
  }
});
