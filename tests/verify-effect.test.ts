import assert from "node:assert/strict";
import test from "node:test";
import { createPublishEffect, type PublishInput } from "../examples/rest-resource/effect.js";
import { DocumentService } from "../examples/rest-resource/service.js";
import { defineEffect } from "../src/index.js";
import { assertEffectVerified, verifyEffect } from "../src/testing/index.js";
import type { AnyEffectAdapter } from "../src/core/adapter.js";
import type { Reconciliation } from "../src/core/types.js";

const INPUT: PublishInput = {
  documentId: "doc_verify",
  status: "published",
  tags: ["release"]
};

/** A fresh service on a fresh port, so each scenario starts from a known state. */
async function freshSubject(): Promise<{
  adapter: AnyEffectAdapter;
  input: PublishInput;
  cleanup: () => Promise<void>;
  service: DocumentService;
  baseUrl: string;
}> {
  const service = new DocumentService();
  service.seed({ id: INPUT.documentId, title: "Verify", status: "draft", tags: [] });
  const baseUrl = await service.listen();
  return {
    adapter: createPublishEffect(baseUrl),
    input: INPUT,
    cleanup: () => service.close(),
    service,
    baseUrl
  };
}

test("the worked example passes its own chaos suite", async () => {
  // The concurrency scenario needs a live service handle, so it has its own test.
  const report = await verifyEffect<PublishInput>({
    setup: freshSubject,
    skip: ["compensation-refuses-concurrent-edit"]
  });

  assertEffectVerified(report);
  assert.equal(report.ok, true, report.summary);
  assert.ok(
    report.scenarios.some(
      (scenario) =>
        scenario.name === "lost-acknowledgement-is-recoverable" && scenario.status === "passed"
    ),
    "the scenario that proves findEvidence works must actually run"
  );
});

test("compensation refuses to overwrite a concurrent edit", async () => {
  let current: Awaited<ReturnType<typeof freshSubject>> | undefined;
  const report = await verifyEffect<PublishInput>({
    setup: async () => {
      current = await freshSubject();
      return current;
    },
    concurrentEdit: async () => {
      const service = current?.service;
      const baseUrl = current?.baseUrl;
      assert.ok(service !== undefined && baseUrl !== undefined);
      // Somebody else edits the same document between verification and the undo.
      const response = await fetch(`${baseUrl}/documents/${INPUT.documentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "outside-writer" },
        body: JSON.stringify({ status: "archived" })
      });
      assert.equal(response.status, 200);
    },
    skip: [
      "commits-once",
      "canonical-input-is-stable",
      "observation-is-stable",
      "lost-acknowledgement-is-recoverable",
      "undispatched-request-is-not-claimed",
      "repeat-is-refused-as-no-op",
      "downstream-failure-is-compensated"
    ]
  });

  assertEffectVerified(report);
});

test("a provider that will not start is reported, not thrown", async () => {
  // setup() touches a real provider, so it is one of the likeliest things to
  // fail. The caller must still get a report back.
  const report = await verifyEffect<PublishInput>({
    setup: () => {
      throw new Error("the provider would not start");
    },
    skip: [
      "canonical-input-is-stable",
      "observation-is-stable",
      "lost-acknowledgement-is-recoverable",
      "undispatched-request-is-not-claimed",
      "foreign-change-is-not-claimed",
      "repeat-is-refused-as-no-op",
      "downstream-failure-is-compensated",
      "compensation-refuses-concurrent-edit"
    ]
  });

  assert.equal(report.ok, false);
  const first = report.scenarios.find((scenario) => scenario.name === "commits-once");
  assert.equal(first?.status, "failed");
  assert.match(first?.detail ?? "", /setup\(\) threw: the provider would not start/);
});

test("the suite fails an effect that reads evidence out of current state", async () => {
  interface Doc {
    id: string;
    status: string;
    version: number;
  }

  const report = await verifyEffect<{ id: string; status: string }>({
    setup: () => {
      const store = new Map<string, Doc>([["d1", { id: "d1", status: "draft", version: 1 }]]);
      return {
        input: { id: "d1", status: "published" },
        adapter: defineEffect<{ id: string; status: string }, Doc>({
          operation: "test.docs.publish",
          contract: { name: "test.docs.publish", version: "1.0.0" },
          materialFields: ["status"],
          resourceScope: (input) => [{ type: "document", id: input.id }],
          observe: (input) => ({ ...store.get(input.id)! }),
          version: (state) => String(state.version),
          expected: (input, before) => ({ ...before, status: input.status }),
          dispatch: ({ input }) => {
            const current = store.get(input.id)!;
            store.set(input.id, { ...current, status: input.status, version: current.version + 1 });
          },
          // The plausible mistake: the state looks right, so it must have been me.
          findEvidence: ({ input, expected }) =>
            store.get(input.id)?.status === expected.status
              ? { providerRequestId: "inferred" }
              : undefined,
          compensate: ({ input, restore }) => {
            const current = store.get(input.id)!;
            store.set(input.id, { ...current, ...restore, version: current.version + 1 });
          }
        })
      };
    }
  });

  const foreign = report.scenarios.find(
    (scenario) => scenario.name === "foreign-change-is-not-claimed"
  );
  assert.equal(
    foreign?.status,
    "failed",
    "inferring evidence from state must not survive the suite"
  );
  assert.match(foreign?.detail ?? "", /logicalOperationId/);
  // Every other scenario passes, which is exactly why this one has to exist.
  assert.equal(
    report.scenarios.filter((scenario) => scenario.status === "failed").length,
    1
  );
});

test("the suite fails an effect whose findEvidence cannot prove its own dispatch", async () => {
  const report = await verifyEffect<PublishInput>({
    setup: async () => {
      const subject = await freshSubject();
      return {
        ...subject,
        // A definition that answers "did operation X commit?" with a shrug is
        // the single most common way to get this wrong.
        adapter: new Proxy(subject.adapter, {
          get(target, property, receiver): unknown {
            if (property === "reconcile") {
              return async (preflight: never): Promise<Reconciliation<unknown>> => ({
                resolved: false,
                committed: false,
                observed: (await target.observeCurrentState(preflight)) as unknown,
                finality: "UNKNOWN",
                reason: "This provider cannot say what happened"
              });
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        })
      };
    },
    skip: [
      "canonical-input-is-stable",
      "observation-is-stable",
      "repeat-is-refused-as-no-op",
      "downstream-failure-is-compensated",
      "compensation-refuses-concurrent-edit"
    ]
  });

  assert.equal(report.ok, false, "a definition that cannot reconcile must not pass");
  const lost = report.scenarios.find(
    (scenario) => scenario.name === "lost-acknowledgement-is-recoverable"
  );
  assert.equal(lost?.status, "failed");
  assert.ok(
    lost?.detail.includes("findEvidence"),
    "the failure must name the function that has to change"
  );
  assert.throws(() => assertEffectVerified(report), /lost-acknowledgement-is-recoverable/);
});
