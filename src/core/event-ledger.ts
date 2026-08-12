import { randomUUID } from "node:crypto";
import { canonicalize, sha256 } from "./canonical-json.js";
import { ZeroGateError } from "./errors.js";
import { assertActionTransition, assertTransactionTransition } from "./state-machine.js";
import type {
  ActionState,
  JsonValue,
  PublicLedgerEvent,
  StoredLedgerEvent,
  TransactionState
} from "./types.js";

export interface AppendEventInput {
  id?: string;
  source?: string;
  type: string;
  subject: string;
  data: Record<string, JsonValue>;
  correlationId?: string;
  causationId?: string;
  traceparent?: string;
  expectedSequence?: number;
  time?: string;
}

export interface EventLedger {
  readonly tenantId: string | undefined;
  append(input: AppendEventInput): Promise<StoredLedgerEvent>;
  list(subject?: string): Promise<StoredLedgerEvent[]>;
  chainRoot(subject?: string): Promise<string>;
  verify(): Promise<boolean>;
}

export function canonicalEventTime(value?: string): string {
  const candidate = value ?? new Date().toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    candidate
  );
  const parsed = new Date(candidate);
  const invalidCalendarDate = (() => {
    if (match === null) return true;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offset = match[8]!;
    const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
    const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth[month - 1]! ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 23 ||
      offsetMinute > 59
    );
  })();
  if (invalidCalendarDate || Number.isNaN(parsed.getTime())) {
    throw new ZeroGateError(
      "UNSUPPORTED",
      "Event time must be a valid RFC 3339 timestamp",
      false
    );
  }
  return parsed.toISOString();
}

export class InMemoryEventLedger implements EventLedger {
  public readonly tenantId = undefined;
  readonly #events: StoredLedgerEvent[] = [];
  readonly #appendFingerprints = new Map<string, string>();

  public async append(input: AppendEventInput): Promise<StoredLedgerEvent> {
    const eventId = input.id ?? randomUUID();
    const existing = this.#events.find((event) => event.id === eventId);
    const source = input.source ?? "urn:zerogate";
    const time = canonicalEventTime(input.time ?? existing?.time);
    const data = structuredClone(input.data);
    const appendFingerprint = sha256(
      canonicalize({
        source,
        type: input.type,
        subject: input.subject,
        time,
        data,
        ...(input.traceparent === undefined ? {} : { traceparent: input.traceparent }),
        ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId })
      })
    );
    if (existing !== undefined) {
      if (this.#appendFingerprints.get(eventId) !== appendFingerprint) {
        throw new ZeroGateError(
          "LEDGER_CONFLICT",
          `Event ID ${eventId} was reused with different content`,
          false,
          { eventId }
        );
      }
      return structuredClone(existing);
    }

    const subjectEvents = this.#events.filter((event) => event.subject === input.subject);
    const nextSequence = subjectEvents.length + 1;
    if (input.expectedSequence !== undefined && input.expectedSequence !== nextSequence) {
      throw new ZeroGateError(
        "LEDGER_CONFLICT",
        `Expected subject sequence ${input.expectedSequence}, actual ${nextSequence}`,
        true,
        { subject: input.subject }
      );
    }

    const previousHash = subjectEvents.at(-1)?.eventHash ?? "GENESIS";
    const publicEvent: PublicLedgerEvent = {
      specversion: "1.0",
      id: eventId,
      source,
      type: input.type,
      subject: input.subject,
      time,
      sequence: nextSequence,
      ...(input.traceparent === undefined ? {} : { traceparent: input.traceparent }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      datacontenttype: "application/json",
      data
    };
    const eventHash = sha256(`${previousHash}\n${canonicalize(publicEvent)}`);
    const event: StoredLedgerEvent = { ...publicEvent, previousHash, eventHash };
    this.#events.push(event);
    this.#appendFingerprints.set(eventId, appendFingerprint);
    return structuredClone(event);
  }

  public async list(subject?: string): Promise<StoredLedgerEvent[]> {
    const events = subject === undefined ? this.#events : this.#events.filter((event) => event.subject === subject);
    return structuredClone(events);
  }

  public async chainRoot(subject?: string): Promise<string> {
    if (subject !== undefined) {
      return this.#events.filter((event) => event.subject === subject).at(-1)?.eventHash ?? sha256("GENESIS");
    }
    const roots: Record<string, string> = {};
    for (const event of this.#events) roots[event.subject] = event.eventHash;
    return Object.keys(roots).length === 0 ? sha256("GENESIS") : sha256(canonicalize(roots));
  }

  public async verify(): Promise<boolean> {
    const previousHashes = new Map<string, string>();
    const sequences = new Map<string, number>();
    for (const event of this.#events) {
      const previousHash = previousHashes.get(event.subject) ?? "GENESIS";
      const expectedSequence = (sequences.get(event.subject) ?? 0) + 1;
      const { eventHash, previousHash: storedPreviousHash, ...publicEvent } = event;
      if (storedPreviousHash !== previousHash) return false;
      if (event.sequence !== expectedSequence) return false;
      const expected = sha256(`${previousHash}\n${canonicalize(publicEvent)}`);
      if (expected !== eventHash) return false;
      previousHashes.set(event.subject, eventHash);
      sequences.set(event.subject, expectedSequence);
    }
    return true;
  }
}

export function verifyEventChain(events: readonly StoredLedgerEvent[]): { valid: boolean; root: string } {
  const previousHashes = new Map<string, string>();
  const sequences = new Map<string, number>();
  for (const event of events) {
    const previousHash = previousHashes.get(event.subject) ?? "GENESIS";
    const expectedSequence = (sequences.get(event.subject) ?? 0) + 1;
    const { eventHash, previousHash: storedPreviousHash, ...publicEvent } = event;
    if (storedPreviousHash !== previousHash || event.sequence !== expectedSequence) {
      return { valid: false, root: chainRootFor(previousHashes) };
    }
    const expected = sha256(`${previousHash}\n${canonicalize(publicEvent)}`);
    if (expected !== eventHash) return { valid: false, root: chainRootFor(previousHashes) };
    previousHashes.set(event.subject, eventHash);
    sequences.set(event.subject, expectedSequence);
  }
  return { valid: true, root: chainRootFor(previousHashes) };
}

function chainRootFor(previousHashes: ReadonlyMap<string, string>): string {
  if (previousHashes.size === 0) return sha256("GENESIS");
  if (previousHashes.size === 1) return [...previousHashes.values()][0]!;
  return sha256(canonicalize(Object.fromEntries(previousHashes)));
}

export interface ReplayedProjection {
  transactionState?: string;
  actionState?: string;
  transactionTransitions: string[];
  actionTransitions: string[];
}

export function replayProjection(events: readonly StoredLedgerEvent[]): ReplayedProjection {
  const chain = verifyEventChain(events);
  if (!chain.valid) {
    throw new ZeroGateError("LEDGER_INTEGRITY_FAILED", "Cannot replay an invalid event chain", false);
  }
  const projection: ReplayedProjection = {
    transactionTransitions: [],
    actionTransitions: []
  };
  for (const event of events) {
    if (event.type === "dev.zerogate.transaction.state_changed.v1") {
      const from = event.data["from"];
      const to = event.data["to"];
      if (typeof from !== "string" || typeof to !== "string") {
        throw new ZeroGateError(
          "LEDGER_INTEGRITY_FAILED",
          "Transaction transition event is missing from/to states",
          false
        );
      }
      if (projection.transactionState !== undefined && projection.transactionState !== from) {
        throw new ZeroGateError(
          "LEDGER_INTEGRITY_FAILED",
          `Transaction projection expected ${projection.transactionState}, event claimed ${from}`,
          false
        );
      }
      assertTransactionTransition(from as TransactionState, to as TransactionState);
      projection.transactionState = to;
      projection.transactionTransitions.push(to);
    }
    if (event.type === "dev.zerogate.action.state_changed.v1") {
      const from = event.data["from"];
      const to = event.data["to"];
      if (typeof from !== "string" || typeof to !== "string") {
        throw new ZeroGateError(
          "LEDGER_INTEGRITY_FAILED",
          "Action transition event is missing from/to states",
          false
        );
      }
      if (projection.actionState !== undefined && projection.actionState !== from) {
        throw new ZeroGateError(
          "LEDGER_INTEGRITY_FAILED",
          `Action projection expected ${projection.actionState}, event claimed ${from}`,
          false
        );
      }
      assertActionTransition(from as ActionState, to as ActionState);
      projection.actionState = to;
      projection.actionTransitions.push(to);
    }
  }
  return projection;
}
