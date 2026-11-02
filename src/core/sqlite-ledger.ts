import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { InMemoryEventLedger, type AppendEventInput, type EventLedger } from "./event-ledger.js";
import type { StoredLedgerEvent } from "./types.js";

// Keep Node's optional SQLite types out of the public declaration files.
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(): { event: string }[];
    run(...values: string[]): unknown;
  };
  close(): void;
}

/**
 * A real SQLite-backed EventLedger for a single process. Each append is an
 * atomic SQLite transaction around the shared event rules.
 * Open a new instance to inspect retained events after a restart; interrupted
 * transactions are not automatically resumed by the engine.
 */
export class SqliteLedger implements EventLedger {
  public readonly tenantId = undefined;
  readonly #database: SqliteDatabase;
  #pending: Promise<unknown> = Promise.resolve();

  public constructor(filePath: string) {
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    this.#database = new DatabaseSync(filePath);
    try {
      this.#database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS zerogate_events (
          position INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          event TEXT NOT NULL
        );
      `);
      this.#snapshot();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  #snapshot(): InMemoryEventLedger {
    const events = this.#database.prepare("SELECT event FROM zerogate_events ORDER BY position").all()
      .map((row) => JSON.parse(row.event) as StoredLedgerEvent);
    return new InMemoryEventLedger(events);
  }

  public append(input: AppendEventInput): Promise<StoredLedgerEvent> {
    const ownedInput = structuredClone(input);
    const operation = this.#pending.then(async () => {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const ledger = this.#snapshot();
        const event = await ledger.append(ownedInput);
        this.#database.prepare("INSERT OR IGNORE INTO zerogate_events (id, event) VALUES (?, ?)")
          .run(event.id, JSON.stringify(event));
        this.#database.exec("COMMIT");
        return event;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  public async list(subject?: string): Promise<StoredLedgerEvent[]> {
    await this.#pending;
    return this.#snapshot().list(subject);
  }

  public async chainRoot(subject?: string): Promise<string> {
    await this.#pending;
    return this.#snapshot().chainRoot(subject);
  }

  public async verify(): Promise<boolean> {
    await this.#pending;
    try { return await this.#snapshot().verify(); } catch { return false; }
  }

  /** Wait for queued appends before releasing the database handle. */
  public async close(): Promise<void> {
    await this.#pending;
    this.#database.close();
  }
}
