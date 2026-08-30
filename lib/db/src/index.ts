import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

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
});
export const db = drizzle(pool, { schema });

export * from "./authority";
export * from "./schema";
