import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Client, Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

if (
  process.env.NODE_ENV === "test" &&
  (!process.env.TEST_ISOLATION_SCHEMA || !process.env.TEST_ISOLATION_DATABASE)
) {
  throw new Error(
    "Tests must run through the isolated test runner; isolated database markers are missing.",
  );
}

function applicationRoleDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const existingOptions = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existingOptions, "-c role=pbs_app"].filter(Boolean).join(" "),
  );
  url.search = `?${url.searchParams.toString().replaceAll("+", "%20")}`;
  return url.toString();
}

export const pool = new Pool({
  connectionString: applicationRoleDatabaseUrl(process.env.DATABASE_URL),
  connectionTimeoutMillis: 10_000,
});
export const db = drizzle(pool, { schema });

export function getDatabaseTargetFingerprint(): {
  host: string;
  port: string;
  database: string;
  configuredUser: string;
} {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to inspect the database target.");
  }

  const parsedUrl = new URL(databaseUrl);
  return {
    host: parsedUrl.hostname,
    port: parsedUrl.port || "5432",
    database: decodeURIComponent(parsedUrl.pathname.replace(/^\//, "")),
    configuredUser: decodeURIComponent(parsedUrl.username),
  };
}

export async function inspectDatabaseAuthorityTarget(): Promise<{
  database: string;
  user: string;
  pbsAppRoleCount: number;
  connectionLatencyMs: number;
}> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to inspect the database target.");
  }

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
  });
  const startedAt = performance.now();
  let connected = false;

  try {
    await client.connect();
    connected = true;
    const connectionLatencyMs = Math.round(performance.now() - startedAt);
    const result = await client.query<{
      database: string;
      user: string;
      pbs_app_role_count: string;
    }>(`
      SELECT
        current_database() AS database,
        current_user AS user,
        (
          SELECT count(*)::text
          FROM pg_roles
          WHERE rolname = 'pbs_app'
        ) AS pbs_app_role_count
    `);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Database target inspection returned no result.");
    }

    return {
      database: row.database,
      user: row.user,
      pbsAppRoleCount: Number(row.pbs_app_role_count),
      connectionLatencyMs,
    };
  } finally {
    if (connected) {
      await Promise.race([
        client.end().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  }
}

export * from "./authority";
export * from "./schema";
