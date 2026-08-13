import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { hashCanonical } from "../core/canonical-json.js";
import { verifyEventChain } from "../core/event-ledger.js";
import { KeyStore } from "../core/key-store.js";
import { verifyReceipt } from "../core/receipt.js";
import type { SignedReceipt, StoredLedgerEvent } from "../core/types.js";

const require = createRequire(import.meta.url);

const USAGE = `zerogate — verified side-effect execution

Usage:
  zerogate receipt verify <receipt.json> <events.json> <public-key.pem>
      Independently check a receipt's signature, its event chain, and that the
      chain root the receipt commits to is the one the events actually produce.
      Needs no ZeroGate runtime and no network access.

  zerogate contract digest <contract.json>
      Print the canonical digest of an Effect Contract. Pin this in code so a
      contract change invalidates approvals bound to the old one.

  zerogate keys new [--out <dir>] [--name <name>]
      Generate an Ed25519 receipt-signing keypair.

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
`;

interface CommandResult {
  exitCode: number;
}

function fail(message: string): never {
  process.stderr.write(`zerogate: ${message}\n`);
  process.exit(2);
}

function packageVersion(): string {
  try {
    const manifest = require("../../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Verifies a receipt the way a third party would: from the files alone.
 *
 * A receipt is only worth something if it can be checked by someone who does
 * not trust the process that produced it, so this reads JSON off disk and
 * re-derives every claim rather than asking the engine.
 */
async function verifyReceiptCommand(argv: readonly string[]): Promise<CommandResult> {
  const [receiptPath, eventsPath, publicKeyPath] = argv;
  if (receiptPath === undefined || eventsPath === undefined || publicKeyPath === undefined) {
    fail("usage: zerogate receipt verify <receipt.json> <events.json> <public-key.pem>");
  }

  const receipt = JSON.parse(await readFile(resolve(receiptPath), "utf8")) as SignedReceipt;
  const events = JSON.parse(await readFile(resolve(eventsPath), "utf8")) as StoredLedgerEvent[];
  const publicKey = await readFile(resolve(publicKeyPath), "utf8");

  const subjectEvents = events.filter((event) => event.subject === receipt.transactionId);
  const receiptEventIndex = subjectEvents.findIndex(
    (event) =>
      event.type === "dev.zerogate.receipt.issued.v1" &&
      event.data["receiptId"] === receipt.receiptId
  );
  if (receiptEventIndex < 0) {
    process.stdout.write(
      `${JSON.stringify({ authentic: false, reason: "receipt-issued event is missing" }, null, 2)}\n`
    );
    return { exitCode: 1 };
  }

  const receiptEvent = subjectEvents[receiptEventIndex]!;
  const coveredEvents = subjectEvents.slice(0, receiptEventIndex);
  const covered = verifyEventChain(coveredEvents);
  const full = verifyEventChain(subjectEvents);
  const signatureValid = verifyReceipt(receipt, publicKey);
  const rootMatches = covered.root === receipt.integrity.eventChainRoot;
  const receiptEventMatches =
    receiptEvent.data["receiptId"] === receipt.receiptId &&
    receiptEvent.data["finalStatus"] === receipt.finalStatus &&
    receiptEvent.data["keyId"] === receipt.integrity.keyId &&
    receiptEvent.data["coveredEventChainRoot"] === receipt.integrity.eventChainRoot &&
    receiptEvent.data["signatureHash"] === hashCanonical(receipt.integrity.signature) &&
    receiptEventIndex === subjectEvents.length - 1;

  const authentic =
    signatureValid && covered.valid && full.valid && rootMatches && receiptEventMatches;

  // `finalStatus` leads, and the verdict is named `authentic` rather than `ok`,
  // because they answer different questions: a receipt for a transaction that
  // required a human is perfectly authentic.
  process.stdout.write(
    `${JSON.stringify(
      {
        finalStatus: receipt.finalStatus,
        finality: receipt.finality,
        authentic,
        transactionId: receipt.transactionId,
        signatureValid,
        coveredEventChainValid: covered.valid,
        fullEventChainValid: full.valid,
        rootMatches,
        receiptEventMatches,
        coveredEvents: coveredEvents.length
      },
      null,
      2
    )}\n`
  );
  return { exitCode: authentic ? 0 : 1 };
}

async function contractDigestCommand(argv: readonly string[]): Promise<CommandResult> {
  const [contractPath] = argv;
  if (contractPath === undefined) fail("usage: zerogate contract digest <contract.json>");
  const contract: unknown = JSON.parse(await readFile(resolve(contractPath), "utf8"));
  process.stdout.write(`${hashCanonical(contract)}\n`);
  return { exitCode: 0 };
}

async function keysNewCommand(argv: readonly string[]): Promise<CommandResult> {
  let outDir = ".zerogate/keys";
  let name = "receipt-signing-key";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--out") {
      if (value === undefined) fail("--out requires a directory");
      outDir = value;
      index += 1;
    } else if (flag === "--name") {
      if (value === undefined) fail("--name requires a name");
      name = value;
      index += 1;
    } else {
      fail(`unknown option ${String(flag)}`);
    }
  }

  const target = resolve(outDir);
  await mkdir(target, { recursive: true });
  const keyPair = new KeyStore(target).getOrCreateKeyPair(name);
  await writeFile(join(target, `${name}.pem`), keyPair.privateKeyPem, { mode: 0o600 });
  await writeFile(join(target, `${name}.pub.pem`), keyPair.publicKeyPem);

  process.stdout.write(
    `${JSON.stringify(
      {
        keyId: keyPair.keyId,
        privateKey: join(outDir, `${name}.pem`),
        publicKey: join(outDir, `${name}.pub.pem`)
      },
      null,
      2
    )}\n`
  );
  process.stderr.write(
    "Keep the private key out of version control. Distribute only the .pub.pem file.\n"
  );
  return { exitCode: 0 };
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  if (command === "receipt") {
    if (rest[0] !== "verify") fail(`unknown receipt subcommand ${String(rest[0] ?? "")}`);
    return (await verifyReceiptCommand(rest.slice(1))).exitCode;
  }
  if (command === "contract") {
    if (rest[0] !== "digest") fail(`unknown contract subcommand ${String(rest[0] ?? "")}`);
    return (await contractDigestCommand(rest.slice(1))).exitCode;
  }
  if (command === "keys") {
    if (rest[0] !== "new") fail(`unknown keys subcommand ${String(rest[0] ?? "")}`);
    return (await keysNewCommand(rest.slice(1))).exitCode;
  }

  fail(`unknown command ${command}. Run 'zerogate --help'.`);
}
