import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";
import type { ErrorObject, Options, ValidateFunction } from "ajv";
import { PUBLISH_INPUT, startPublishHarness } from "./helpers/publish-harness.js";

/**
 * ajv ships CommonJS with ESM-style declarations, which makes a default import
 * resolve to the module namespace under NodeNext. Requiring it and naming only
 * the two methods used here is stable across that packaging detail.
 */
interface SchemaValidator {
  compile(schema: unknown): ValidateFunction;
  errorsText(errors?: ErrorObject[] | null): string;
}

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as new (options?: Options) => SchemaValidator;
const addFormats = require("ajv-formats") as (validator: SchemaValidator) => unknown;

/**
 * The schemas under `schemas/` are published in the npm tarball, so third
 * parties write verifiers against them. Nothing else in the build reads them,
 * which means without this file they would drift away from the receipts the
 * engine actually emits — and the drift would surface in someone else's code.
 */

// Compiled output lives at dist/tests/, so the repository root is two levels up.
const schemaUrl = (name: string): URL => new URL(`../../schemas/${name}`, import.meta.url);

async function loadSchema(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(schemaUrl(name), "utf8")) as Record<string, unknown>;
}

function createValidator(): SchemaValidator {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv;
}

test("every published schema is itself valid", async () => {
  for (const name of [
    "receipt.schema.json",
    "effect-contract.schema.json",
    "intent-envelope.schema.json",
    "ledger-event.schema.json"
  ]) {
    const ajv = createValidator();
    const schema = await loadSchema(name);
    assert.doesNotThrow(() => ajv.compile(schema), `${name} does not compile`);
  }
});

test("a receipt the engine emits validates against the published receipt schema", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const ajv = createValidator();
  const validate = ajv.compile(await loadSchema("receipt.schema.json"));

  const committed = await harness.run({ input: PUBLISH_INPUT });
  const compensated = await harness.run({
    input: { documentId: "doc_release_notes", status: "archived", tags: ["archived", "release"] },
    finalize: () => {
      throw new Error("downstream work failed");
    }
  });

  for (const result of [committed, compensated]) {
    const receipt: unknown = JSON.parse(JSON.stringify(result.receipt));
    const valid = validate(receipt);
    assert.equal(
      valid,
      true,
      `${result.receipt.finalStatus} receipt failed validation: ${ajv.errorsText(validate.errors)}`
    );
  }
});

test("ledger events the engine emits validate against the published event schema", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const ajv = createValidator();
  const validate = ajv.compile(await loadSchema("ledger-event.schema.json"));

  const result = await harness.run({ input: PUBLISH_INPUT });
  assert.ok(result.events.length > 0);
  for (const event of result.events) {
    const valid = validate(JSON.parse(JSON.stringify(event)));
    assert.equal(
      valid,
      true,
      `event ${event.type} failed validation: ${ajv.errorsText(validate.errors)}`
    );
  }
});

test("the intent envelope recorded in a receipt validates against its schema", async (t) => {
  const harness = await startPublishHarness();
  t.after(() => harness.close());

  const ajv = createValidator();
  const validate = ajv.compile(await loadSchema("intent-envelope.schema.json"));

  const result = await harness.run({ input: PUBLISH_INPUT });
  const binding = result.receipt.intentBinding;
  const envelope = {
    schemaVersion: "1.0",
    tenantId: binding.tenantId,
    environment: binding.environment,
    actor: binding.actor,
    purpose: binding.purpose,
    resourceScope: binding.resourceScope,
    limits: result.transaction.intent.limits,
    expiresAt: binding.expiresAt
  };
  assert.equal(
    validate(JSON.parse(JSON.stringify(envelope))),
    true,
    `intent envelope failed validation: ${ajv.errorsText(validate.errors)}`
  );
});
