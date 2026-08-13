import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

/**
 * Every TypeScript example in the documentation is compiled, as written.
 *
 * The quickstart in this repository once did not compile: `defineEffect({...})`
 * without explicit type arguments infers `TState` as `object`, so the very
 * first snippet a reader copies failed on `state.version`. Nothing caught it,
 * because nothing compiled it. This does.
 *
 * Snippets are checked at plain `strict: true` — the setting a reader is
 * likely to have — not at this repository's stricter settings.
 */

const run = promisify(execFile);
const root = new URL("../../", import.meta.url);
const rootPath = fileURLToPath(root);
/** Backslashes in a generated import specifier are string escapes, not paths. */
const importRoot = rootPath.replaceAll("\\", "/");
const scratch = new URL(".scratch/docs-snippets/", root);

const SOURCES = ["README.md", "docs/README.md"];

/** Snippets import the package by name; here it is still source. */
function resolveImports(snippet: string): string {
  return snippet
    .replaceAll(/from "zerogate\/testing"/g, `from "${importRoot}src/testing/index.js"`)
    .replaceAll(/from "zerogate\/postgres"/g, `from "${importRoot}src/postgres/event-ledger.js"`)
    .replaceAll(/from "zerogate"/g, `from "${importRoot}src/index.js"`)
    // The contract is a JSON import in the real examples and a global here.
    .replaceAll(/^import contract from .*$/gm, "")
    .replaceAll(/^import .* from "\.\/.*"$/gm, "");
}

function extractTypeScriptBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map(([, body]) => body ?? "");
}

test("every TypeScript example in the documentation compiles", async () => {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });

  const files: string[] = [];
  for (const source of SOURCES) {
    const markdown = await readFile(new URL(source, root), "utf8");
    const blocks = extractTypeScriptBlocks(markdown);
    assert.ok(blocks.length > 0, `${source} has no TypeScript examples to check`);
    for (const [index, block] of blocks.entries()) {
      const name = `${source.replaceAll(/[/.]/g, "_")}_${index}.ts`;
      await writeFile(new URL(name, scratch), resolveImports(block), "utf8");
      files.push(name);
    }
  }

  await writeFile(
    new URL("tsconfig.json", scratch),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          types: ["node"],
          noEmit: true
        },
        files: [...files, `${importRoot}tests/fixtures/docs-globals.d.ts`]
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    await run(
      process.execPath,
      [fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)), "-p", fileURLToPath(scratch)],
      { cwd: rootPath }
    );
  } catch (error: unknown) {
    const output = (error as { stdout?: string }).stdout ?? String(error);
    assert.fail(
      `A documented TypeScript example does not compile. Readers copy these verbatim.\n\n${output}`
    );
  }
});
