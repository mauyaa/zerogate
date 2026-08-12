import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import pg, { type Pool as PgPool, type PoolClient, type QueryResultRow } from "pg";
import {
  verifyEventChain,
  type AppendEventInput
} from "../src/core/event-ledger.js";
import { PostgresEventLedger } from "../src/postgres/event-ledger.js";

const adminDatabaseUrl = process.env["ZEROGATE_TEST_ADMIN_DATABASE_URL"];
const { Pool } = pg;

interface CurrentDatabaseRow extends QueryResultRow {
  databaseName: string;
}

interface RoleSecurityRow extends QueryResultRow {
  canLogin: boolean;
  isSuperuser: boolean;
  bypassesRls: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
}

interface VisibleEventRow extends QueryResultRow {
  tenantId: string;
  eventId: string;
  subject: string;
  sequence: number;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hasDatabaseCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === expected;
}

function databaseConnectionString(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

function appConnectionString(
  databaseUrl: string,
  roleName: string,
  password: string
): string {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("ZEROGATE_TEST_ADMIN_DATABASE_URL must be a PostgreSQL URL");
  }
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function migrate(pool: PgPool): Promise<void> {
  const migrationFiles = (await readdir(resolve("migrations")))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of migrationFiles) {
    await pool.query(await readFile(resolve("migrations", file), "utf8"));
  }
}

async function setTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('zerogate.tenant_id', $1, true)", [tenantId]);
}

async function visibleEvents(
  pool: PgPool,
  tenantId: string | undefined,
  eventId: string
): Promise<VisibleEventRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenantId !== undefined) await setTenant(client, tenantId);
    const result = await client.query<VisibleEventRow>(
      `SELECT
         tenant_id AS "tenantId",
         event_id AS "eventId",
         subject,
         subject_sequence::integer AS sequence
       FROM ledger_events
       WHERE event_id = $1
       ORDER BY tenant_id`,
      [eventId]
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertAppStatementDenied(
  pool: PgPool,
  tenantId: string,
  statement: string,
  parameters: readonly unknown[] = []
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenant(client, tenantId);
    await assert.rejects(
      () => client.query(statement, [...parameters]),
      hasDatabaseCode("42501")
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function assertAdminImmutabilityTrigger(
  pool: PgPool,
  statement: string,
  parameters: readonly unknown[] = [],
  tenantId?: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenantId !== undefined) await setTenant(client, tenantId);
    await assert.rejects(
      () => client.query(statement, [...parameters]),
      hasDatabaseCode("55000")
    );
  } finally {
    // A missing TRUNCATE trigger must fail the assertion without clearing shared test data.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

test(
  "PostgreSQL ledger enforces tenant-scoped idempotency, RLS, concurrency, and immutability",
  { skip: adminDatabaseUrl === undefined },
  async () => {
    assert.ok(adminDatabaseUrl !== undefined);

    const controlPool = new Pool({
      connectionString: adminDatabaseUrl,
      application_name: "zerogate-ledger-test-control",
      max: 4
    });
    const databaseName = `zg_test_${randomUUID().replaceAll("-", "")}`;
    const databaseIdentifier = quoteIdentifier(databaseName);
    const roleName = `zg_test_${randomUUID().replaceAll("-", "")}`;
    const roleIdentifier = quoteIdentifier(roleName);
    const rolePassword = `${randomUUID()}_${randomUUID()}`;
    let databasePool: PgPool | undefined;
    let appPool: PgPool | undefined;
    let databaseCreated = false;
    let roleCreated = false;
    let primaryError: unknown;

    try {
      await controlPool.query(`CREATE DATABASE ${databaseIdentifier}`);
      databaseCreated = true;
      const isolatedDatabaseUrl = databaseConnectionString(adminDatabaseUrl, databaseName);
      const isolatedAdminPool = new Pool({
        connectionString: isolatedDatabaseUrl,
        application_name: "zerogate-ledger-test-admin",
        max: 4
      });
      databasePool = isolatedAdminPool;
      await migrate(isolatedAdminPool);

      const databaseResult = await isolatedAdminPool.query<CurrentDatabaseRow>(
        'SELECT current_database() AS "databaseName"'
      );
      assert.equal(databaseResult.rows[0]?.databaseName, databaseName);

      await controlPool.query(
        `CREATE ROLE ${roleIdentifier}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
         LOGIN PASSWORD ${quoteLiteral(rolePassword)}`
      );
      roleCreated = true;
      await isolatedAdminPool.query(
        `GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${roleIdentifier}`
      );
      await isolatedAdminPool.query(`GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`);
      await isolatedAdminPool.query(
        `GRANT SELECT, INSERT ON TABLE public.ledger_events TO ${roleIdentifier}`
      );
      await isolatedAdminPool.query(
        `GRANT USAGE ON SEQUENCE public.ledger_events_global_sequence_seq TO ${roleIdentifier}`
      );
      await isolatedAdminPool.query(
        `GRANT SELECT, INSERT, UPDATE ON TABLE public.ledger_chain_heads TO ${roleIdentifier}`
      );

      const security = await controlPool.query<RoleSecurityRow>(
        `SELECT
           rolcanlogin AS "canLogin",
           rolsuper AS "isSuperuser",
           rolbypassrls AS "bypassesRls",
           rolcreatedb AS "canCreateDatabase",
           rolcreaterole AS "canCreateRole",
           rolreplication AS "canReplicate"
         FROM pg_roles
         WHERE rolname = $1`,
        [roleName]
      );
      assert.deepEqual(security.rows[0], {
        canLogin: true,
        isSuperuser: false,
        bypassesRls: false,
        canCreateDatabase: false,
        canCreateRole: false,
        canReplicate: false
      });

      appPool = new Pool({
        connectionString: appConnectionString(
          isolatedDatabaseUrl,
          roleName,
          rolePassword
        ),
        application_name: "zerogate-ledger-test-app",
        max: 12
      });

      const tenantA = `tenant_${randomUUID()}`;
      const tenantB = `tenant_${randomUUID()}`;
      const ledgerA = new PostgresEventLedger({ tenantId: tenantA, pool: appPool });
      const ledgerB = new PostgresEventLedger({ tenantId: tenantB, pool: appPool });

      const sharedEventId = randomUUID();
      const sharedSubject = `subject_${randomUUID()}`;
      const offsetMicrosecondTime = "2035-01-02T03:04:05.123456+05:30";
      const canonicalTime = "2035-01-01T21:34:05.123Z";
      const sharedInput: AppendEventInput = {
        id: sharedEventId,
        type: "dev.zerogate.test.tenant_shared.v1",
        subject: sharedSubject,
        time: offsetMicrosecondTime,
        data: { nested: { step: 1 }, labels: ["audit", "tenant"] }
      };

      const [tenantAFirst, tenantBFirst] = await Promise.all([
        ledgerA.append(sharedInput),
        ledgerB.append(sharedInput)
      ]);
      assert.deepEqual(tenantBFirst, tenantAFirst);
      assert.equal(tenantAFirst.sequence, 1);
      assert.equal(tenantBFirst.sequence, 1);
      assert.equal(tenantAFirst.time, canonicalTime);
      assert.equal(tenantAFirst.previousHash, "GENESIS");

      const invalidTimeSubject = `invalid_time_${randomUUID()}`;
      await assert.rejects(() =>
        ledgerA.append({
          id: randomUUID(),
          type: "dev.zerogate.test.invalid_time.v1",
          subject: invalidTimeSubject,
          time: "not-a-valid-rfc3339-time",
          data: { rejected: true }
        })
      );
      assert.deepEqual(await ledgerA.list(invalidTimeSubject), []);

      const duplicateEventId = randomUUID();
      const duplicateSubject = `duplicate_${randomUUID()}`;
      const duplicateInput: AppendEventInput = {
        id: duplicateEventId,
        type: "dev.zerogate.test.concurrent_duplicate.v1",
        subject: duplicateSubject,
        time: "2036-02-03T04:05:06.789Z",
        data: { delivery: "same" }
      };
      const duplicateDeliveries = await Promise.all(
        Array.from({ length: 8 }, () => ledgerA.append(duplicateInput))
      );
      for (const delivery of duplicateDeliveries) {
        assert.deepEqual(delivery, duplicateDeliveries[0]);
      }
      assert.equal((await ledgerA.list(duplicateSubject)).length, 1);

      const concurrentSubject = `concurrent_${randomUUID()}`;
      const concurrentCount = 8;
      await Promise.all(
        Array.from({ length: concurrentCount }, (_, index) =>
          ledgerA.append({
            id: randomUUID(),
            type: "dev.zerogate.test.concurrent_append.v1",
            subject: concurrentSubject,
            data: { index }
          })
        )
      );
      const concurrentEvents = await ledgerA.list(concurrentSubject);
      assert.deepEqual(
        concurrentEvents.map((event) => event.sequence),
        Array.from({ length: concurrentCount }, (_, index) => index + 1)
      );
      assert.equal(verifyEventChain(concurrentEvents).valid, true);
      assert.equal(
        await ledgerA.chainRoot(concurrentSubject),
        concurrentEvents.at(-1)?.eventHash
      );

      assert.deepEqual(await ledgerA.list(sharedSubject), [tenantAFirst]);
      assert.deepEqual(await ledgerB.list(sharedSubject), [tenantBFirst]);
      assert.equal(await ledgerA.chainRoot(sharedSubject), tenantAFirst.eventHash);
      assert.equal(await ledgerB.chainRoot(sharedSubject), tenantBFirst.eventHash);
      assert.equal(await ledgerA.verify(), true);
      assert.equal(await ledgerB.verify(), true);
      const allTenantAEvents = await ledgerA.list();
      const allTenantBEvents = await ledgerB.list();
      assert.equal(await ledgerA.chainRoot(), verifyEventChain(allTenantAEvents).root);
      assert.equal(await ledgerB.chainRoot(), verifyEventChain(allTenantBEvents).root);
      assert.equal(allTenantBEvents.length, 1);
      assert.equal(allTenantAEvents.length, concurrentCount + 2);

      assert.deepEqual(await visibleEvents(appPool, undefined, sharedEventId), []);
      assert.deepEqual(await visibleEvents(appPool, tenantA, sharedEventId), [
        {
          tenantId: tenantA,
          eventId: sharedEventId,
          subject: sharedSubject,
          sequence: 1
        }
      ]);
      assert.deepEqual(await visibleEvents(appPool, tenantB, sharedEventId), [
        {
          tenantId: tenantB,
          eventId: sharedEventId,
          subject: sharedSubject,
          sequence: 1
        }
      ]);

      await assertAppStatementDenied(
        appPool,
        tenantA,
        `INSERT INTO ledger_events (
           tenant_id, event_id, subject, subject_sequence, source, event_type,
           event_time, data, previous_hash, event_hash
         ) VALUES ($1, $2, $3, 1, 'urn:zerogate:test',
           'dev.zerogate.test.cross_tenant.v1', now(), '{}'::jsonb, 'GENESIS', $4)`,
        [tenantB, randomUUID(), `cross_tenant_${randomUUID()}`, "f".repeat(64)]
      );
      await assertAppStatementDenied(
        appPool,
        tenantA,
        "UPDATE ledger_events SET data = data WHERE tenant_id = $1 AND event_id = $2",
        [tenantA, sharedEventId]
      );
      await assertAppStatementDenied(appPool, tenantA, "TRUNCATE TABLE ledger_events");

      await isolatedAdminPool.query(
        `UPDATE ledger_chain_heads
         SET last_hash = $3
         WHERE tenant_id = $1 AND subject = $2`,
        [tenantA, sharedSubject, "e".repeat(64)]
      );
      await assert.rejects(
        () => ledgerA.chainRoot(sharedSubject),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "LEDGER_INTEGRITY_FAILED"
      );
      assert.equal(await ledgerA.verify(), false);
      const eventCountBeforeRejectedAppend = (await ledgerA.list(sharedSubject)).length;
      await assert.rejects(
        () =>
          ledgerA.append({
            id: randomUUID(),
            type: "dev.zerogate.test.corrupt_head_append.v1",
            subject: sharedSubject,
            data: { rejected: true }
          }),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "LEDGER_INTEGRITY_FAILED"
      );
      assert.equal(
        (await ledgerA.list(sharedSubject)).length,
        eventCountBeforeRejectedAppend
      );
      await isolatedAdminPool.query(
        `UPDATE ledger_chain_heads
         SET last_hash = $3
         WHERE tenant_id = $1 AND subject = $2`,
        [tenantA, sharedSubject, tenantAFirst.eventHash]
      );
      assert.equal(await ledgerA.verify(), true);

      await assertAdminImmutabilityTrigger(
        isolatedAdminPool,
        "UPDATE ledger_events SET data = data WHERE tenant_id = $1 AND event_id = $2",
        [tenantA, sharedEventId],
        tenantA
      );
      await assertAdminImmutabilityTrigger(
        isolatedAdminPool,
        "TRUNCATE TABLE ledger_events"
      );
    } catch (error: unknown) {
      // Held rather than rethrown so teardown still runs, and so a cleanup
      // failure can never mask the assertion that actually failed.
      primaryError = error;
    }

    const cleanupErrors: unknown[] = [];
    const clean = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    };
    if (appPool !== undefined) await clean(() => appPool.end());
    if (databasePool !== undefined && roleCreated) {
      await clean(() => databasePool.query(`DROP OWNED BY ${roleIdentifier}`));
    }
    if (databasePool !== undefined) await clean(() => databasePool.end());
    if (databaseCreated) {
      await clean(() =>
        controlPool.query(`DROP DATABASE IF EXISTS ${databaseIdentifier} WITH (FORCE)`)
      );
    }
    if (roleCreated) {
      await clean(() => controlPool.query(`DROP ROLE IF EXISTS ${roleIdentifier}`));
    }
    await clean(() => controlPool.end());

    if (primaryError !== undefined) {
      throw primaryError instanceof Error
        ? primaryError
        : new Error(`The test body threw a non-Error value: ${JSON.stringify(primaryError)}`);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "PostgreSQL integration-test cleanup failed");
    }
  }
);
