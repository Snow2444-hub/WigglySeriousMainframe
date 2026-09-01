import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseUrl =
  process.env.NODE_ENV === "production"
    ? process.env.PBS_DATABASE_URL ?? process.env.DATABASE_URL
    : process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "A database URL must be set. Production may use PBS_DATABASE_URL; other environments use DATABASE_URL.",
  );
}
const configuredDatabaseUrl: string = databaseUrl;

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
  connectionString: applicationRoleDatabaseUrl(configuredDatabaseUrl),
  connectionTimeoutMillis: 10_000,
});
export const db = drizzle(pool, { schema });

export * from "./authority";
export * from "./schema";
