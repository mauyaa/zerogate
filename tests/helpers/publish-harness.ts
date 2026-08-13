import { createPublishEffect, type PublishInput } from "../../examples/rest-resource/effect.js";
import { DocumentService } from "../../examples/rest-resource/service.js";
import { TransactionEngine, type RunInput } from "../../src/index.js";
import type { EventLedger } from "../../src/core/event-ledger.js";
import type { Actor, Observation } from "../../src/core/types.js";

export const TEST_ACTOR: Actor = {
  principalId: "u_release",
  agentId: "release-agent",
  agentVersion: "1.0.0"
};

/**
 * Boots the example REST service over a real socket and wires a ZeroGate engine
 * to it. Tests exercise the whole path — HTTP, idempotency keys, conditional
 * requests, evidence lookup — rather than a stand-in for it.
 */
export async function startPublishHarness(options: { ledger?: EventLedger } = {}): Promise<{
  service: DocumentService;
  baseUrl: string;
  run(
    input: Omit<RunInput<PublishInput>, "actor" | "purpose"> &
      Partial<Pick<RunInput<PublishInput>, "actor" | "purpose">>
  ): ReturnType<ReturnType<typeof buildEngine>["run"]>;
  engine: ReturnType<typeof buildEngine>;
  close(): Promise<void>;
}> {
  const service = new DocumentService();
  service.seed({
    id: "doc_release_notes",
    title: "Release v2.4",
    status: "draft",
    tags: ["release", "needs-review"]
  });
  const baseUrl = await service.listen();
  const engine = buildEngine(baseUrl, options.ledger);

  return {
    service,
    baseUrl,
    engine,
    run: (input) =>
      engine.run({
        actor: TEST_ACTOR,
        purpose: "Publish the release notes",
        ...input
      }),
    close: () => service.close()
  };
}

function buildEngine(baseUrl: string, ledger?: EventLedger) {
  return new TransactionEngine({
    adapter: createPublishEffect(baseUrl),
    ...(ledger === undefined ? {} : { ledger })
  });
}

/**
 * Finds one recorded observation by kind, narrowed to that member of the union.
 *
 * Reading evidence should be a `switch`, not a cast — the tests use the same
 * path a caller does, so a regression in that ergonomics shows up here.
 */
export function findObservation<TKind extends Observation["kind"]>(
  observations: readonly Observation[] | undefined,
  kind: TKind
): Extract<Observation, { kind: TKind }> | undefined {
  return observations?.find(
    (observation): observation is Extract<Observation, { kind: TKind }> =>
      observation.kind === kind
  );
}

export const PUBLISH_INPUT: PublishInput = {
  documentId: "doc_release_notes",
  status: "published",
  tags: ["release", "shipped"]
};
