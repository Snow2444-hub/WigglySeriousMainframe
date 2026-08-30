import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { ingestionRunsTable } from "./schema/ingestion-runs";

export const PRODUCTION_AUTHORITY_SCOPE = "production" as const;
export const TEST_AUTHORITY_SCOPE_PREFIX = "test:" as const;

export function productionMasterScope(column: SQLWrapper): SQL {
  return sql`${column} = ${PRODUCTION_AUTHORITY_SCOPE}`;
}

export function productionAuthorityRun(authorityRunIdColumn: SQLWrapper): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${ingestionRunsTable}
    WHERE ${ingestionRunsTable.id} = ${authorityRunIdColumn}
      AND ${ingestionRunsTable.authorityScope} = ${PRODUCTION_AUTHORITY_SCOPE}
  )`;
}

export function runtimeAuthorityScope(): string {
  if (process.env.NODE_ENV !== "test") return PRODUCTION_AUTHORITY_SCOPE;
  const token = process.env.TEST_ISOLATION_SCHEMA;
  if (!token) {
    throw new Error("TEST_ISOLATION_SCHEMA is required to create a test authority scope.");
  }
  return `${TEST_AUTHORITY_SCOPE_PREFIX}${token}`;
}

export function assertTestAuthorityScope(scope: string): void {
  if (!scope.startsWith(TEST_AUTHORITY_SCOPE_PREFIX) || scope.length === TEST_AUTHORITY_SCOPE_PREFIX.length) {
    throw new Error("Test authority scope must use a non-empty test: token.");
  }
}