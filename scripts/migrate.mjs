import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import pg from "pg";

const connectionString =
  process.env.ZEROGATE_DATABASE_URL ??
  "postgresql://postgres:zerogate@127.0.0.1:5432/zerogate";
const migrationFiles = (await readdir(resolve("migrations")))
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();

if (migrationFiles.length === 0) throw new Error("No SQL migrations were found");

const { Client } = pg;
const client = new Client({ connectionString, application_name: "zerogate-migrations" });
await client.connect();

try {
  await client.query(
    "SELECT pg_advisory_lock(hashtextextended('zerogate:schema-migrations', 0))"
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS zerogate_schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text
    )
  `);
  await client.query(
    "ALTER TABLE zerogate_schema_migrations ADD COLUMN IF NOT EXISTS checksum text"
  );

  for (const file of migrationFiles) {
    const version = basename(file, ".sql");
    const sql = await readFile(resolve("migrations", file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const recorded = await client.query(
      "SELECT checksum FROM zerogate_schema_migrations WHERE version = $1",
      [version]
    );
    const existingChecksum = recorded.rows[0]?.checksum;
    if (typeof existingChecksum === "string") {
      if (existingChecksum !== checksum) {
        throw new Error(`Migration ${version} checksum does not match the applied migration`);
      }
      continue;
    }

    await client.query(sql);
    await client.query(
      `INSERT INTO zerogate_schema_migrations(version, checksum)
       VALUES ($1, $2)
       ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum`,
      [version, checksum]
    );
  }
} finally {
  await client
    .query("SELECT pg_advisory_unlock(hashtextextended('zerogate:schema-migrations', 0))")
    .catch(() => undefined);
  await client.end();
}
