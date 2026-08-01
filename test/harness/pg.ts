// test/harness/pg.ts
//
// Opt-in Postgres support for the test suite.
//
// `npm test` must never require a database: the contract suite runs against
// the in-memory store unconditionally, and the Postgres run is an additional
// check that the two agree. A developer without a server sees skipped suites,
// not failures.
//
// Bring a server up with `bash scripts/test-pg.sh`, which prints the
// DATABASE_URL to export.

// Deliberately free of any vitest import: the soak script (plain tsx, no test
// runner) uses these helpers, and importing vitest outside a worker throws.
// The vitest-only wrapper lives in ./describeWithPg.ts.
import { readFile } from "node:fs/promises";
import { OPERATIONS_SCHEMA_PATH } from "../../src/ops/OperationStore.js";

// pg ships CommonJS; the named export is not reachable through ESM interop.
import pgDefault from "pg";
const { Pool } = pgDefault;
type Pool = InstanceType<typeof Pool>;

export interface PgProbe {
  available: boolean;
  url: string | undefined;
  reason: string | undefined;
}

/**
 * Check whether a usable Postgres is reachable.
 *
 * Call at test-file top level and hand the result to {@link describeWithPg}.
 * Probing here rather than in `beforeAll` is what lets an unreachable server
 * skip the suite instead of failing it.
 */
export async function probePostgres(): Promise<PgProbe> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    return { available: false, url: undefined, reason: "DATABASE_URL is not set" };
  }

  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3_000 });
  try {
    await pool.query("SELECT 1");
    return { available: true, url, reason: undefined };
  } catch (e) {
    return { available: false, url, reason: `cannot reach ${url}: ${(e as Error).message}` };
  } finally {
    await pool.end().catch(() => { /* probe teardown is best effort */ });
  }
}

/** Open a pool against DATABASE_URL. Caller owns `end()`. */
export function openPool(url: string, max = 4): Pool {
  return new Pool({ connectionString: url, max });
}

/**
 * Apply the DDL and make sure a partition exists for the rows tests write.
 *
 * Tomorrow's partition is created too: a test running near midnight UTC would
 * otherwise insert into a range nothing covers and fail on a partition error
 * that has nothing to do with the behaviour under test.
 */
export async function applySchema(pool: Pool): Promise<void> {
  const ddl = await readFile(OPERATIONS_SCHEMA_PATH, "utf8");
  await pool.query(ddl);
  await pool.query("SELECT create_operations_partition(current_date)");
  await pool.query("SELECT create_operations_partition(current_date + 1)");
}

/** Empty both tables, leaving the schema in place. */
export async function resetOperations(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE operations, operations_history");
}

export type { Pool as PgPool };
