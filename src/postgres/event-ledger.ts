import pg, {
  type Pool as PgPool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow
} from "pg";
import { canonicalize, sha256 } from "../core/canonical-json.js";
import { ZeroGateError } from "../core/errors.js";
import {
  canonicalEventTime,
  verifyEventChain,
  type AppendEventInput,
  type EventLedger
} from "../core/event-ledger.js";
import type {
  JsonValue,
  PublicLedgerEvent,
  StoredLedgerEvent
} from "../core/types.js";

const { Pool } = pg;

interface LedgerRow extends QueryResultRow {
  id: string;
  source: string;
  type: string;
  subject: string;
  time: Date | string;
  sequence: string | number;
  traceparent: string | null;
  causationId: string | null;
  correlationId: string | null;
  data: Record<string, JsonValue>;
  previousHash: string;
  eventHash: string;
}

interface ChainHeadRow extends QueryResultRow {
  subject: string;
  lastSequence: string | number;
  lastHash: string;
}

interface ChainTailRow extends QueryResultRow {
  sequence: string | number;
  eventHash: string;
}

export interface PostgresEventLedgerOptions {
  tenantId: string;
  pool?: PgPool;
  connectionString?: string;
  applicationName?: string;
}

/**
 * PostgreSQL-backed append-only event ledger.
 *
 * Every operation sets a transaction-local tenant context for RLS. This guards
 * application queries that accidentally omit a tenant predicate; it is not an
 * authorization boundary for callers that can run arbitrary SQL and choose the
 * session setting. Use a least-privilege application role at that boundary.
 * Appends take deterministic advisory locks for the event ID and subject, then
 * update the event row and subject chain head in one database transaction.
 */
export class PostgresEventLedger implements EventLedger {
  public readonly tenantId: string;
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;

  public constructor(options: PostgresEventLedgerOptions) {
    if (options.tenantId.trim().length === 0) {
      throw new ZeroGateError("UNSUPPORTED", "PostgreSQL ledger tenant ID is required", false);
    }
    this.tenantId = options.tenantId;
    this.#ownsPool = options.pool === undefined;
    if (options.pool !== undefined) {
      this.#pool = options.pool;
    } else {
      const config: PoolConfig = {
        application_name: options.applicationName ?? "zerogate"
      };
      if (options.connectionString !== undefined) {
        config.connectionString = options.connectionString;
      }
      this.#pool = new Pool(config);
    }
  }

  public async append(input: AppendEventInput): Promise<StoredLedgerEvent> {
    const eventId = input.id ?? crypto.randomUUID();
    const source = input.source ?? "urn:zerogate";
    let stableTime = input.time === undefined ? undefined : canonicalEventTime(input.time);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#withTransaction(async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`event:${this.tenantId}:${eventId}`]
          );
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`subject:${this.tenantId}:${input.subject}`]
          );

          const existingResult = await client.query<LedgerRow>(
            `${SELECT_EVENT_COLUMNS}
             FROM ledger_events
             WHERE tenant_id = $1 AND event_id = $2`,
            [this.tenantId, eventId]
          );
          const existingRow = existingResult.rows[0];
          const existing =
            existingRow === undefined ? undefined : mapLedgerRow(existingRow);
          stableTime ??= existing?.time ?? canonicalEventTime();
          const time = canonicalEventTime(stableTime);
          const data = structuredClone(input.data);

          if (existing !== undefined) {
            if (
              input.expectedSequence !== undefined &&
              input.expectedSequence !== existing.sequence
            ) {
              throw new ZeroGateError(
                "LEDGER_CONFLICT",
                `Event ${eventId} already exists at a different sequence`,
                false,
                { eventId }
              );
            }
            const candidate = makePublicEvent({
              input,
              eventId,
              source,
              time,
              sequence: existing.sequence,
              data
            });
            const candidateHash = sha256(
              `${existing.previousHash}\n${canonicalize(candidate)}`
            );
            if (candidateHash !== existing.eventHash) {
              throw new ZeroGateError(
                "LEDGER_CONFLICT",
                `Event ID ${eventId} was reused with different content`,
                false,
                { eventId }
              );
            }
            return existing;
          }

          const headResult = await client.query<ChainHeadRow>(
            `SELECT subject, last_sequence AS "lastSequence", last_hash AS "lastHash"
             FROM ledger_chain_heads
             WHERE tenant_id = $1 AND subject = $2
             FOR UPDATE`,
            [this.tenantId, input.subject]
          );
          const head = headResult.rows[0];
          const tailResult = await client.query<ChainTailRow>(
            `SELECT subject_sequence AS sequence, event_hash AS "eventHash"
             FROM ledger_events
             WHERE tenant_id = $1 AND subject = $2
             ORDER BY subject_sequence DESC
             LIMIT 1`,
            [this.tenantId, input.subject]
          );
          const tail = tailResult.rows[0];
          if (
            (head === undefined) !== (tail === undefined) ||
            (head !== undefined &&
              tail !== undefined &&
              (toSafeInteger(head.lastSequence) !== toSafeInteger(tail.sequence) ||
                head.lastHash !== tail.eventHash))
          ) {
            throw new ZeroGateError(
              "LEDGER_INTEGRITY_FAILED",
              `PostgreSQL chain head does not match the event tail for subject ${input.subject}`,
              false,
              { subject: input.subject }
            );
          }
          const previousSequence =
            head === undefined ? 0 : toSafeInteger(head.lastSequence);
          const sequence = previousSequence + 1;
          if (
            input.expectedSequence !== undefined &&
            input.expectedSequence !== sequence
          ) {
            throw new ZeroGateError(
              "LEDGER_CONFLICT",
              `Expected subject sequence ${input.expectedSequence}, actual ${sequence}`,
              true,
              { subject: input.subject }
            );
          }
          const previousHash = head?.lastHash ?? "GENESIS";
          const publicEvent = makePublicEvent({
            input,
            eventId,
            source,
            time,
            sequence,
            data
          });
          const eventHash = sha256(
            `${previousHash}\n${canonicalize(publicEvent)}`
          );

          const inserted = await client.query<LedgerRow>(
            `INSERT INTO ledger_events (
               tenant_id, event_id, subject, subject_sequence, source, event_type,
               event_time, correlation_id, causation_id, traceparent, data,
               previous_hash, event_hash
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
             RETURNING
               event_id AS id,
               source,
               event_type AS type,
               subject,
               event_time AS time,
               subject_sequence AS sequence,
               traceparent,
               causation_id AS "causationId",
               correlation_id AS "correlationId",
               data,
               previous_hash AS "previousHash",
               event_hash AS "eventHash"`,
            [
              this.tenantId,
              publicEvent.id,
              publicEvent.subject,
              publicEvent.sequence,
              publicEvent.source,
              publicEvent.type,
              publicEvent.time,
              publicEvent.correlationId ?? null,
              publicEvent.causationId ?? null,
              publicEvent.traceparent ?? null,
              JSON.stringify(publicEvent.data),
              previousHash,
              eventHash
            ]
          );

          if (head === undefined) {
            await client.query(
              `INSERT INTO ledger_chain_heads (
                 tenant_id, subject, last_sequence, last_hash, updated_at
               ) VALUES ($1, $2, $3, $4, now())`,
              [this.tenantId, input.subject, sequence, eventHash]
            );
          } else {
            const update = await client.query(
              `UPDATE ledger_chain_heads
               SET last_sequence = $3, last_hash = $4, updated_at = now()
               WHERE tenant_id = $1 AND subject = $2
                 AND last_sequence = $5 AND last_hash = $6`,
              [
                this.tenantId,
                input.subject,
                sequence,
                eventHash,
                previousSequence,
                previousHash
              ]
            );
            if (update.rowCount !== 1) {
              throw new ZeroGateError(
                "LEDGER_INTEGRITY_FAILED",
                "The subject chain head changed outside the ledger append protocol",
                false,
                { subject: input.subject }
              );
            }
          }

          const row = inserted.rows[0];
          if (row === undefined) {
            throw new ZeroGateError(
              "LEDGER_INTEGRITY_FAILED",
              "PostgreSQL did not return the appended event",
              false
            );
          }
          return mapLedgerRow(row);
        });
      } catch (error: unknown) {
        const databaseCode =
          error instanceof ZeroGateError ? error.details["databaseCode"] : undefined;
        if (
          !(error instanceof ZeroGateError) ||
          !error.retryable ||
          typeof databaseCode !== "string" ||
          attempt === 3
        ) {
          throw error;
        }
      }
    }

    throw new ZeroGateError(
      "LEDGER_CONFLICT",
      "PostgreSQL ledger retry budget was exhausted",
      true
    );
  }

  public async list(subject?: string): Promise<StoredLedgerEvent[]> {
    return this.#withTransaction((client) => this.#readEvents(client, subject));
  }

  public async chainRoot(subject?: string): Promise<string> {
    return this.#withTransaction(
      async (client) => {
        if (subject !== undefined) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`subject:${this.tenantId}:${subject}`]
          );
        }
        const events = await this.#readEvents(client, subject);
        return this.#assertChainHeads(client, events, subject);
      },
      subject === undefined ? "REPEATABLE READ" : "READ COMMITTED"
    );
  }

  public async verify(): Promise<boolean> {
    return this.#withTransaction(
      async (client) => {
        const events = await this.#readEvents(client);
        try {
          await this.#assertChainHeads(client, events);
          return true;
        } catch (error: unknown) {
          if (
            error instanceof ZeroGateError &&
            error.code === "LEDGER_INTEGRITY_FAILED"
          ) {
            return false;
          }
          throw error;
        }
      },
      "REPEATABLE READ"
    );
  }

  public async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async #readEvents(
    client: PoolClient,
    subject?: string
  ): Promise<StoredLedgerEvent[]> {
    const result = await client.query<LedgerRow>(
      subject === undefined
        ? `${SELECT_EVENT_COLUMNS}
           FROM ledger_events
           WHERE tenant_id = $1
           ORDER BY global_sequence`
        : `${SELECT_EVENT_COLUMNS}
           FROM ledger_events
           WHERE tenant_id = $1 AND subject = $2
           ORDER BY subject_sequence`,
      subject === undefined ? [this.tenantId] : [this.tenantId, subject]
    );
    return result.rows.map(mapLedgerRow);
  }

  async #assertChainHeads(
    client: PoolClient,
    events: readonly StoredLedgerEvent[],
    subject?: string
  ): Promise<string> {
    const verified = verifyEventChain(events);
    if (!verified.valid) {
      throw new ZeroGateError(
        "LEDGER_INTEGRITY_FAILED",
        "PostgreSQL event links or hashes are invalid",
        false
      );
    }

    const headResult = await client.query<ChainHeadRow>(
      subject === undefined
        ? `SELECT subject, last_sequence AS "lastSequence", last_hash AS "lastHash"
           FROM ledger_chain_heads
           WHERE tenant_id = $1
           ORDER BY subject`
        : `SELECT subject, last_sequence AS "lastSequence", last_hash AS "lastHash"
           FROM ledger_chain_heads
           WHERE tenant_id = $1 AND subject = $2`,
      subject === undefined ? [this.tenantId] : [this.tenantId, subject]
    );
    const expectedHeads = new Map<string, { sequence: number; hash: string }>();
    for (const event of events) {
      expectedHeads.set(event.subject, {
        sequence: event.sequence,
        hash: event.eventHash
      });
    }

    if (headResult.rows.length !== expectedHeads.size) {
      throw new ZeroGateError(
        "LEDGER_INTEGRITY_FAILED",
        "PostgreSQL chain-head count does not match the event ledger",
        false
      );
    }
    for (const head of headResult.rows) {
      const expected = expectedHeads.get(head.subject);
      if (
        expected === undefined ||
        expected.sequence !== toSafeInteger(head.lastSequence) ||
        expected.hash !== head.lastHash
      ) {
        throw new ZeroGateError(
          "LEDGER_INTEGRITY_FAILED",
          `PostgreSQL chain head is inconsistent for subject ${head.subject}`,
          false,
          { subject: head.subject }
        );
      }
    }
    return verified.root;
  }

  async #withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    isolation: "READ COMMITTED" | "REPEATABLE READ" = "READ COMMITTED"
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error: unknown) {
      throw asLedgerDatabaseError(error);
    }
    let destroyClient = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SELECT set_config('zerogate.tenant_id', $1, true)", [
        this.tenantId
      ]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof ZeroGateError) throw error;
      const code = databaseErrorCode(error);
      destroyClient = isBrokenConnection(code);
      throw asLedgerDatabaseError(error);
    } finally {
      client.release(destroyClient);
    }
  }
}

const SELECT_EVENT_COLUMNS = `SELECT
  event_id AS id,
  source,
  event_type AS type,
  subject,
  event_time AS time,
  subject_sequence AS sequence,
  traceparent,
  causation_id AS "causationId",
  correlation_id AS "correlationId",
  data,
  previous_hash AS "previousHash",
  event_hash AS "eventHash"`;

function makePublicEvent(input: {
  input: AppendEventInput;
  eventId: string;
  source: string;
  time: string;
  sequence: number;
  data: Record<string, JsonValue>;
}): PublicLedgerEvent {
  return {
    specversion: "1.0",
    id: input.eventId,
    source: input.source,
    type: input.input.type,
    subject: input.input.subject,
    time: input.time,
    sequence: input.sequence,
    ...(input.input.traceparent === undefined
      ? {}
      : { traceparent: input.input.traceparent }),
    ...(input.input.causationId === undefined
      ? {}
      : { causationId: input.input.causationId }),
    ...(input.input.correlationId === undefined
      ? {}
      : { correlationId: input.input.correlationId }),
    datacontenttype: "application/json",
    data: input.data
  };
}

function mapLedgerRow(row: LedgerRow): StoredLedgerEvent {
  const time = canonicalEventTime(
    row.time instanceof Date ? row.time.toISOString() : row.time
  );
  return {
    specversion: "1.0",
    id: row.id,
    source: row.source,
    type: row.type,
    subject: row.subject,
    time,
    sequence: toSafeInteger(row.sequence),
    ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
    ...(row.causationId === null ? {} : { causationId: row.causationId }),
    ...(row.correlationId === null ? {} : { correlationId: row.correlationId }),
    datacontenttype: "application/json",
    data: structuredClone(row.data),
    previousHash: row.previousHash,
    eventHash: row.eventHash
  };
}

function toSafeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ZeroGateError(
      "LEDGER_INTEGRITY_FAILED",
      "PostgreSQL ledger sequence exceeds JavaScript's safe integer range",
      false
    );
  }
  return parsed;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  if ("code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if ("cause" in error) {
    const causeCode = databaseErrorCode((error as { cause?: unknown }).cause);
    if (causeCode !== undefined) return causeCode;
  }
  if ("errors" in error && Array.isArray((error as { errors?: unknown }).errors)) {
    for (const nested of (error as { errors: unknown[] }).errors) {
      const nestedCode = databaseErrorCode(nested);
      if (nestedCode !== undefined) return nestedCode;
    }
  }
  return undefined;
}

function asLedgerDatabaseError(error: unknown): ZeroGateError {
  if (error instanceof ZeroGateError) return error;
  const code = databaseErrorCode(error);
  const retryable = isRetryableDatabaseFailure(code);
  return new ZeroGateError(
    "LEDGER_CONFLICT",
    retryable
      ? "PostgreSQL ledger transaction must be retried"
      : "PostgreSQL ledger transaction failed",
    retryable,
    code === undefined ? {} : { databaseCode: code }
  );
}

function isRetryableDatabaseFailure(code: string | undefined): boolean {
  return (
    code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    code === "57014" ||
    isBrokenConnection(code)
  );
}

function isBrokenConnection(code: string | undefined): boolean {
  return (
    code?.startsWith("08") === true ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ENOTFOUND"
  );
}
