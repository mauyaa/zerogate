import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * A small but realistic REST service, used by the ZeroGate example and tests.
 *
 * It behaves the way a well-built API behaves: mutations require an idempotency
 * key, conditional requests are honoured, and a committed operation can be
 * looked up afterwards by that key. Those three properties are exactly what an
 * effect needs in order to be reconcilable, and this service exists to show
 * what ZeroGate requires of a provider.
 *
 * The `/_test/*` routes inject faults. They belong to this example service, not
 * to ZeroGate, and they are how the test suite reproduces a lost
 * acknowledgement or a concurrent human edit against real sockets.
 */

export interface Document {
  id: string;
  title: string;
  status: "draft" | "published" | "archived";
  tags: string[];
  version: number;
  updatedAt: string;
}

export type DocumentPatch = Partial<Pick<Document, "title" | "status" | "tags">>;

/** How the next mutation should misbehave. */
export type FaultMode =
  | "none"
  /** Commit the change, then drop the connection so the client never hears back. */
  | "lost-ack-after-commit"
  /** Refuse before doing anything. Safe to retry. */
  | "refuse-before-commit"
  /** Reject the request outright. */
  | "definitive-rejection";

interface OperationRecord {
  requestId: string;
  payloadHash: string;
  committedAt: string;
  version: number;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function stableHash(value: unknown): string {
  // The service only needs a cheap equality marker for replayed payloads.
  return JSON.stringify(value);
}

export class DocumentService {
  readonly #documents = new Map<string, Document>();
  readonly #operations = new Map<string, OperationRecord>();
  #fault: FaultMode = "none";
  #mutationCount = 0;
  #server: Server | undefined;
  #clock = Date.UTC(2026, 0, 1);

  public seed(document: Omit<Document, "version" | "updatedAt">): Document {
    const seeded: Document = {
      ...document,
      tags: [...document.tags],
      version: 1,
      updatedAt: this.#tick()
    };
    this.#documents.set(seeded.id, structuredClone(seeded));
    return structuredClone(seeded);
  }

  /** Number of mutations that actually reached the store. */
  public get mutationCount(): number {
    return this.#mutationCount;
  }

  public setFault(mode: FaultMode): void {
    this.#fault = mode;
  }

  public read(id: string): Document | undefined {
    const found = this.#documents.get(id);
    return found === undefined ? undefined : structuredClone(found);
  }

  /** An out-of-band change, standing in for a human editing the record. */
  public edit(id: string, patch: DocumentPatch): Document {
    const current = this.#documents.get(id);
    if (current === undefined) throw new Error(`Unknown document ${id}`);
    return this.#apply(current, patch);
  }

  public async listen(): Promise<string> {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) jsonResponse(res, 500, { error: "internal" });
        else res.end();
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  public async close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  #tick(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }

  #apply(current: Document, patch: DocumentPatch): Document {
    const updated: Document = {
      ...current,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
      version: current.version + 1,
      updatedAt: this.#tick()
    };
    this.#documents.set(updated.id, structuredClone(updated));
    return structuredClone(updated);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const segments = url.pathname.split("/").filter((part) => part !== "");

    if (req.method === "POST" && segments[0] === "_test" && segments[1] === "faults") {
      const body = await readJsonBody(req);
      this.#fault = (body["mode"] as FaultMode | undefined) ?? "none";
      jsonResponse(res, 200, { mode: this.#fault });
      return;
    }

    if (req.method === "POST" && segments[0] === "_test" && segments[1] === "edit") {
      const body = await readJsonBody(req);
      const rawId = body["id"];
      const id = typeof rawId === "string" ? rawId : "";
      const current = this.#documents.get(id);
      if (current === undefined) {
        jsonResponse(res, 404, { error: "not_found" });
        return;
      }
      jsonResponse(res, 200, this.#apply(current, body["patch"] as DocumentPatch));
      return;
    }

    if (segments[0] === "operations" && segments.length === 2 && req.method === "GET") {
      const record = this.#operations.get(decodeURIComponent(segments[1]!));
      if (record === undefined) {
        jsonResponse(res, 404, { found: false });
        return;
      }
      jsonResponse(res, 200, {
        found: true,
        requestId: record.requestId,
        committedAt: record.committedAt,
        version: record.version
      });
      return;
    }

    if (segments[0] === "documents" && segments.length === 2) {
      const id = decodeURIComponent(segments[1]!);
      if (req.method === "GET") {
        const document = this.#documents.get(id);
        if (document === undefined) {
          jsonResponse(res, 404, { error: "not_found" });
          return;
        }
        res.setHeader("etag", `"${document.version}"`);
        jsonResponse(res, 200, document);
        return;
      }
      if (req.method === "PATCH") {
        await this.#patch(req, res, id);
        return;
      }
    }

    jsonResponse(res, 404, { error: "not_found" });
  }

  async #patch(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey === "") {
      jsonResponse(res, 400, { error: "idempotency_key_required" });
      return;
    }
    const patch = (await readJsonBody(req)) as DocumentPatch;
    const payloadHash = stableHash(patch);

    // A genuinely idempotent endpoint: the same key never applies twice.
    const existing = this.#operations.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash) {
        jsonResponse(res, 409, { error: "idempotency_key_reused_with_different_payload" });
        return;
      }
      res.setHeader("x-request-id", existing.requestId);
      jsonResponse(res, 200, this.#documents.get(id));
      return;
    }

    const fault = this.#fault;
    if (fault === "refuse-before-commit") {
      this.#fault = "none";
      jsonResponse(res, 503, { error: "unavailable", dispatched: false });
      return;
    }
    if (fault === "definitive-rejection") {
      this.#fault = "none";
      jsonResponse(res, 422, { error: "rejected" });
      return;
    }

    const current = this.#documents.get(id);
    if (current === undefined) {
      jsonResponse(res, 404, { error: "not_found" });
      return;
    }

    const ifMatch = req.headers["if-match"];
    if (typeof ifMatch === "string" && ifMatch !== `"${current.version}"`) {
      jsonResponse(res, 412, { error: "precondition_failed", version: current.version });
      return;
    }

    const updated = this.#apply(current, patch);
    this.#mutationCount += 1;
    const requestId = `req_${randomUUID()}`;
    this.#operations.set(idempotencyKey, {
      requestId,
      payloadHash,
      committedAt: updated.updatedAt,
      version: updated.version
    });

    if (fault === "lost-ack-after-commit") {
      this.#fault = "none";
      // The change is durable, but the caller will never learn that.
      req.socket.destroy();
      return;
    }

    res.setHeader("x-request-id", requestId);
    jsonResponse(res, 200, updated);
  }
}
