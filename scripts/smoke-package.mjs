/**
 * Packs the tarball npm would publish, installs it into a scratch project, and
 * uses it the way a developer would.
 *
 * This is the only check that proves the published artifact actually works:
 * `files`, the `exports` map, the type declarations, and the `bin` entry are all
 * things a passing test suite in this repo cannot verify.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Only npm needs a shell on Windows (it is a .cmd shim). Using one for
    // node would break its own path, which contains a space.
    shell: command.endsWith(".cmd"),
    ...options
  });
}

const workDir = mkdtempSync(join(tmpdir(), "zerogate-smoke-"));
let failed = false;

try {
  // `npm pack` and `npm publish` normalise the manifest differently: pack keeps
  // fields that publish silently drops. A leading "./" in a bin path was
  // accepted by pack and stripped by publish, which would have shipped a
  // package with no `zerogate` command at all. Only a dry-run publish sees it.
  // npm writes these notices to stderr, so both streams have to be inspected.
  const dryRun = spawnSync(npm, ["publish", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: npm.endsWith(".cmd")
  });
  const corrections = `${dryRun.stdout ?? ""}${dryRun.stderr ?? ""}`.match(
    /^.*(?:invalid and removed|auto-corrected).*$/gim
  );
  if (corrections !== null) {
    throw new Error(
      `npm would rewrite the published manifest:\n${corrections.map((line) => `  ${line.trim()}`).join("\n")}`
    );
  }

  const packOutput = run(npm, ["pack", "--json", "--pack-destination", workDir], {
    cwd: repoRoot
  });
  const [packed] = JSON.parse(packOutput);
  const tarball = join(workDir, packed.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);

  const files = packed.files.map((entry) => entry.path);
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "bin/zerogate.js",
    "dist/src/index.js",
    "dist/src/index.d.ts"
  ];
  for (const expected of required) {
    if (!files.includes(expected)) {
      throw new Error(`the published tarball is missing ${expected}`);
    }
  }
  const forbidden = files.filter(
    (entry) =>
      entry.startsWith("dist/tests/") ||
      entry.startsWith("dist/examples/") ||
      entry.endsWith(".pem") ||
      entry.includes(".dev.vars")
  );
  if (forbidden.length > 0) {
    throw new Error(`the published tarball must not contain: ${forbidden.join(", ")}`);
  }

  // A scratch consumer project, exactly as a developer would create one.
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({ name: "zerogate-smoke", private: true, type: "module" }, null, 2)
  );
  run(npm, ["install", "--no-audit", "--no-fund", tarball], { cwd: workDir });

  writeFileSync(
    join(workDir, "use.mjs"),
    `import { TransactionEngine, defineEffect, verifyReceipt, hashCanonical } from "zerogate";

let committed = 0;
const store = { id: "r1", status: "draft", tags: ["a"], version: 1 };
const operations = new Map();

const adapter = defineEffect({
  operation: "smoke.resource.publish",
  contract: { name: "smoke", version: "1.0.0" },
  materialFields: ["status"],
  resourceScope: (input) => [{ type: "smoke.resource", id: input.id }],
  observe: () => ({ ...store, tags: [...store.tags] }),
  version: (state) => String(state.version),
  expected: (input, before) => ({ ...before, status: input.status }),
  dispatch: (context) => {
    committed += 1;
    store.status = context.input.status;
    store.version += 1;
    operations.set(context.logicalOperationId, "req_1");
    return { providerRequestId: "req_1" };
  },
  findEvidence: (context) =>
    operations.has(context.logicalOperationId) ? { providerRequestId: "req_1" } : undefined,
  compensate: (context) => {
    store.status = context.restore.status;
    store.version += 1;
    return { providerRequestId: "req_2" };
  }
});

const engine = new TransactionEngine({ adapter });
const result = await engine.run({
  input: { id: "r1", status: "published" },
  actor: { principalId: "u1", agentId: "smoke", agentVersion: "1.0.0" },
  purpose: "Prove the published package works"
});

const checks = {
  state: result.transaction.state,
  finalStatus: result.receipt.finalStatus,
  signatureValid: verifyReceipt(result.receipt, result.receiptPublicKeyPem),
  dispatches: committed,
  storeStatus: store.status,
  digestWorks: /^sha256:[0-9a-f]{64}$/.test(hashCanonical({ b: 1, a: 2 }))
};

if (
  checks.state !== "VERIFIED_COMMITTED" ||
  checks.finalStatus !== "VERIFIED_COMMITTED" ||
  checks.signatureValid !== true ||
  checks.dispatches !== 1 ||
  checks.storeStatus !== "published" ||
  checks.digestWorks !== true
) {
  console.error("unexpected result", checks);
  process.exit(1);
}
console.log(JSON.stringify(checks));
`
  );

  const libraryOutput = run(process.execPath, ["use.mjs"], { cwd: workDir });

  // Exercise the command through the `bin` linkage npm created, not by file
  // path. Running the file directly passes even when the bin entry is missing,
  // which is how a dropped bin field stayed invisible.
  const binShim = join(workDir, "node_modules", ".bin", isWindows ? "zerogate.cmd" : "zerogate");
  if (!existsSync(binShim)) {
    throw new Error(
      `installing the package did not create ${binShim}; 'npx zerogate' would not work`
    );
  }

  const cliHelp = run(binShim, ["--help"], { cwd: workDir });
  if (!cliHelp.includes("zerogate receipt verify")) {
    throw new Error("the installed CLI did not print its usage");
  }

  const digest = run(
    binShim,
    ["contract", "digest", join(workDir, "node_modules", "zerogate", "package.json")],
    { cwd: workDir }
  ).trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`the installed CLI produced an invalid digest: ${digest}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        tarball: packed.filename,
        unpackedSize: packed.unpackedSize,
        fileCount: files.length,
        library: JSON.parse(libraryOutput.trim()),
        cli: { help: true, digest }
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  failed = true;
  const detail = error.stderr ? String(error.stderr) : "";
  process.stderr.write(`package smoke test failed: ${error.message}\n${detail}\n`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
