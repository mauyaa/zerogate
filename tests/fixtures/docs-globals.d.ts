/**
 * The imaginary provider the documentation examples talk to.
 *
 * Documentation cannot carry a whole application, so the snippets reference an
 * `api` that is never defined in the page. Declaring it here — globally, so a
 * snippet that defines its own binding shadows this one without conflict — is
 * what lets every published snippet be compiled exactly as written.
 */

interface DocsDocument {
  documentId: string;
  status: string;
  tags: string[];
  version: number;
  updatedAt: string;
}

interface DocsResponse {
  headers: { get(name: string): string | null };
  requestId: string;
}

declare const api: {
  get(url: string): Promise<DocsDocument>;
  getDocument(id: string): Promise<DocsDocument>;
  patch(
    url: string,
    init: { headers?: Record<string, string>; body: unknown }
  ): Promise<DocsResponse>;
  patchDocument(
    id: string,
    init: { idempotencyKey: string; ifMatch?: number; body: unknown }
  ): Promise<DocsResponse>;
  findOperation(logicalOperationId: string): Promise<{ providerRequestId?: string } | undefined>;
};

/** A pinned Effect Contract, imported from JSON in the real examples. */
declare const contract: unknown;

declare function notifySubscribers(): Promise<void>;

/** A finished run, for snippets about reading one. */
declare const result: import("../../src/index.js").TransactionResult;
declare const logger: { error(message: string): void };

/** Values a verification snippet is handed by whoever produced the receipt. */
declare const receipt: import("../../src/index.js").SignedReceipt;
declare const publicKeyPem: string;
declare const covered: import("../../src/index.js").StoredLedgerEvent[];
declare const publishDocument: import("../../src/index.js").EffectAdapter<
  { documentId: string; status: string; tags: string[] },
  import("../../src/core/adapter.js").Preflight<DocsDocument>,
  DocsDocument,
  unknown,
  Partial<DocsDocument>
>;
declare const createPublishEffect: (baseUrl: string) => typeof publishDocument;
declare const baseUrl: string;
declare const PUBLISH_INPUT: { documentId: string; status: string; tags: string[] };
