/**
 * Packs the tarball npm would publish, installs it into a scratch project, and
 * uses it the way a developer would.
 *
 * This is the only check that proves the published artifact actually works:
 * `files`, the `exports` map, the type declarations, and the `bin` entry are all
 * things a passing test suite in this repo cannot verify.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

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
  const cliHelp = run(process.execPath, [join(workDir, "node_modules", "zerogate", "bin", "zerogate.js"), "--help"], {
    cwd: workDir
  });
  if (!cliHelp.includes("zerogate receipt verify")) {
    throw new Error("the installed CLI did not print its usage");
  }

  const digest = run(
    process.execPath,
    [
      join(workDir, "node_modules", "zerogate", "bin", "zerogate.js"),
      "contract",
      "digest",
      join(workDir, "node_modules", "zerogate", "package.json")
    ],
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
