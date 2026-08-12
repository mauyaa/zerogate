import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashCanonical, canonicalize } from "./canonical-json.js";
import { ZeroGateError } from "./errors.js";
import type { StoredLedgerEvent } from "./types.js";

export interface SqliteLedgerAppendResult {
  duplicate: boolean;
  event: StoredLedgerEvent;
  ledgerRoot: string;
}

export class SqliteLedger {
  readonly #filePath: string;
  readonly #events: StoredLedgerEvent[] = [];
  readonly #seenIds = new Set<string>();

  public constructor(filePath: string) {
    this.#filePath = filePath;
    this.#hydrate();
  }

  #hydrate(): void {
    if (existsSync(this.#filePath)) {
      try {
        const raw = readFileSync(this.#filePath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          const evt = JSON.parse(line) as StoredLedgerEvent;
          this.#events.push(evt);
          this.#seenIds.add(evt.id);
        }
      } catch (err) {
        console.error("Ledger hydration warning:", err);
      }
    }
  }

  public append(event: StoredLedgerEvent): SqliteLedgerAppendResult {
    if (this.#seenIds.has(event.id)) {
      const existing = this.#events.find((e) => e.id === event.id);
      if (existing && canonicalize(existing) === canonicalize(event)) {
        return { duplicate: true, event: existing, ledgerRoot: this.getChainRoot() };
      }
      throw new ZeroGateError("LEDGER_CONFLICT", "Event ID exists with different content", false);
    }

    this.#events.push(event);
    this.#seenIds.add(event.id);

    const dir = dirname(this.#filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.#filePath, `${JSON.stringify(event)}\n`, { flag: "a", encoding: "utf-8" });

    return { duplicate: false, event, ledgerRoot: this.getChainRoot() };
  }

  public getChainRoot(): string {
    return hashCanonical(this.#events.map((e) => e.id));
  }

  public getEvents(subjectId?: string): StoredLedgerEvent[] {
    if (!subjectId) return [...this.#events];
    return this.#events.filter((e) => e.subject === subjectId);
  }
}
