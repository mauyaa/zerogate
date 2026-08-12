import {
  ProviderSafeToRetryError,
  ProviderTimeoutAfterDispatchError,
  ZeroGateError,
  defineEffect
} from "../../src/index.js";
import contract from "./document-publish.effect.json" with { type: "json" };
import type { Document, DocumentPatch } from "./service.js";

/** Node reports these before a request reaches the network, so nothing committed. */
const NOT_DISPATCHED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_SOCKET_BAD_PORT"
]);

function notDispatched(cause: unknown): boolean {
  const code = (cause as { code?: unknown; cause?: { code?: unknown } } | null)?.code;
  const nested = (cause as { cause?: { code?: unknown } } | null)?.cause?.code;
  return (
    (typeof code === "string" && NOT_DISPATCHED_CODES.has(code)) ||
    (typeof nested === "string" && NOT_DISPATCHED_CODES.has(nested))
  );
}

export interface PublishInput {
  documentId: string;
  status: Document["status"];
  tags: string[];
}

/**
 * Everything ZeroGate needs to know about one operation: publishing a document.
 *
 * Note what is *not* here. Nothing decides when to retry, what to approve, how
 * to hash a payload, when compensation is safe, or what a receipt contains.
 * Those are transaction concerns and the engine owns them. This file only
 * answers provider questions.
 */
export function createPublishEffect(baseUrl: string) {
  const documentUrl = (id: string): string => `${baseUrl}/documents/${encodeURIComponent(id)}`;

  async function readDocument(id: string): Promise<Document> {
    let response: Response;
    try {
      response = await fetch(documentUrl(id));
    } catch (cause: unknown) {
      // A read never changes anything, so a transport failure is always safe to
      // retry — but it must arrive as a typed error, not a raw TypeError.
      throw new ProviderSafeToRetryError(
        `Could not read document ${id}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    if (response.status === 404) {
      throw new ZeroGateError("PROVIDER_REJECTED", `Document ${id} does not exist`, false);
    }
    if (!response.ok) {
      throw new ZeroGateError("PROVIDER_REJECTED", `Read failed with ${response.status}`, true);
    }
    return (await response.json()) as Document;
  }

  async function mutate(input: {
    id: string;
    patch: DocumentPatch;
    logicalOperationId: string;
    expectedVersion?: number;
    preconditionErrorCode: "STALE_WITNESS" | "COMPENSATION_BLOCKED";
  }): Promise<{ providerRequestId?: string; result: Document }> {
    let response: Response;
    try {
      response = await fetch(documentUrl(input.id), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          // The stable operation ID is what makes this dispatch reconcilable.
          "idempotency-key": input.logicalOperationId,
          ...(input.expectedVersion === undefined
            ? {}
            : { "if-match": `"${input.expectedVersion}"` })
        },
        body: JSON.stringify(input.patch)
      });
    } catch (cause: unknown) {
      if (notDispatched(cause)) {
        // The connection was never established, so no change can have landed.
        throw new ProviderSafeToRetryError(
          "The provider was unreachable and the change was never dispatched"
        );
      }
      // The request left this process and never came back. That is not a
      // failure — it is an unknown outcome, and it must be reported as one.
      throw new ProviderTimeoutAfterDispatchError(
        `The provider connection dropped after dispatching ${input.logicalOperationId}`
      );
    }

    if (response.status === 412 || response.status === 409) {
      throw new ZeroGateError(
        input.preconditionErrorCode,
        `Provider state changed before the conditional mutation (${response.status})`,
        false
      );
    }
    if (response.status === 503) {
      throw new ProviderSafeToRetryError("The provider refused before dispatching the change");
    }
    if (!response.ok) {
      throw new ZeroGateError(
        "PROVIDER_REJECTED",
        `The provider rejected the change with ${response.status}`,
        false
      );
    }
    const requestId = response.headers.get("x-request-id");
    return {
      ...(requestId === null ? {} : { providerRequestId: requestId }),
      result: (await response.json()) as Document
    };
  }

  return defineEffect<PublishInput, Document>({
    operation: "example.documents.publish",
    contract,
    materialFields: ["status", "tags"],
    residualRisk: [
      "The provider applies PATCH without a compare-and-set primitive, so freshness is re-checked immediately before dispatch rather than enforced atomically."
    ],

    canonicalizeInput(input) {
      return {
        documentId: input.documentId.trim().normalize("NFC"),
        status: input.status,
        tags: [...new Set(input.tags.map((tag) => tag.trim().normalize("NFC")))].sort((a, b) =>
          a.localeCompare(b, "en")
        )
      };
    },

    normalizeState(state) {
      // Tag order carries no meaning in this API, so it must not read as a
      // change. Without this, reordering tags would dispatch a pointless write.
      return { ...state, tags: [...state.tags].sort((a, b) => a.localeCompare(b, "en")) };
    },

    resourceScope(input) {
      return [{ type: "example.document", id: input.documentId }];
    },

    observe(input) {
      return readDocument(input.documentId);
    },

    version(state) {
      return `${state.version}:${state.updatedAt}`;
    },

    expected(input, before) {
      return { ...before, status: input.status, tags: [...input.tags] };
    },

    async dispatch(context) {
      const outcome = await mutate({
        id: context.input.documentId,
        patch: { status: context.input.status, tags: [...context.input.tags] },
        logicalOperationId: context.logicalOperationId,
        expectedVersion: context.before.version,
        preconditionErrorCode: "STALE_WITNESS"
      });
      return {
        ...(outcome.providerRequestId === undefined
          ? {}
          : { providerRequestId: outcome.providerRequestId }),
        result: outcome.result
      };
    },

    async findEvidence(context) {
      // The provider can answer "did this key commit?" — so an unknown outcome
      // is resolvable without ever dispatching a second time.
      const response = await fetch(
        `${baseUrl}/operations/${encodeURIComponent(context.logicalOperationId)}`
      );
      if (response.status === 404) return undefined;
      if (!response.ok) return undefined;
      const body = (await response.json()) as { requestId?: string; committedAt?: string };
      return {
        ...(body.requestId === undefined ? {} : { providerRequestId: body.requestId }),
        ...(body.committedAt === undefined ? {} : { committedAt: body.committedAt })
      };
    },

    async compensate(context) {
      const outcome = await mutate({
        id: context.input.documentId,
        patch: context.restore,
        logicalOperationId: context.logicalOperationId,
        preconditionErrorCode: "COMPENSATION_BLOCKED"
      });
      return {
        ...(outcome.providerRequestId === undefined
          ? {}
          : { providerRequestId: outcome.providerRequestId }),
        result: outcome.result
      };
    }
  });
}
