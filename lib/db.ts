/**
 * Postgres access.
 *
 * Raw `pg` with hand-written SQL, matching `dream-schools`. An ORM buys little here: the
 * interesting queries are PostGIS spatial joins that every ORM makes harder to read, and
 * the write path is a Python pipeline that does not share the TypeScript models anyway.
 *
 * The database is optional. With no `DATABASE_URL` the service still answers every
 * request by computing live from Overpass — slower and without the precomputed grid, but
 * fully functional. That keeps local development and review apps trivial to run.
 */

import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | null = null;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
  if (!hasDatabase()) {
    throw new Error("DATABASE_URL is not set");
  }
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL as string;
  // Heroku Postgres and Supabase both present certificates that fail default verification.
  const needsSsl = /amazonaws\.com|herokuapp\.com|supabase\.co|render\.com/.test(connectionString) ||
    process.env.PGSSLMODE === "require";

  pool = new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX ?? 6),
    idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECT_MS ?? 8_000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000),
  });

  pool.on("error", (error) => {
    // An idle client erroring out is recoverable; log and let the pool replace it.
    console.error("[db] idle client error", error.message);
  });

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * True when a table exists. Used to degrade gracefully before the pipeline has ever run,
 * so a fresh deploy answers requests instead of 500ing on a missing GTFS table.
 */
const tableCache = new Map<string, boolean>();

export async function tableExists(name: string): Promise<boolean> {
  if (!hasDatabase()) return false;
  const cached = tableCache.get(name);
  if (cached !== undefined) return cached;

  try {
    const row = await queryOne<{ exists: boolean }>(
      "select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = $1) as exists",
      [name]
    );
    const exists = row?.exists ?? false;
    tableCache.set(name, exists);
    return exists;
  } catch {
    return false;
  }
}

export function resetTableCache(): void {
  tableCache.clear();
}
