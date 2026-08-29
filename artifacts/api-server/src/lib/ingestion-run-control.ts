import { db, ingestionRunsTable, type IngestionRun } from "@workspace/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { logger } from "./logger";

export const ACTIVE_INGESTION_STATUSES = ["queued", "running"] as const;
export const INGESTION_RUN_LOCK_KEY = 502_668_451;
type IngestionMode = "current" | "backfill";

export type IngestionRunAcquisition =
  | { run: IngestionRun; activeRun?: never; recoveredRunIds: number[] }
  | { run?: never; activeRun: IngestionRun; recoveredRunIds: number[] };

export function currentScheduleDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Serialises manual and scheduled starts and optionally retires runs left
 * active by a process that was terminated before it could update its status.
 */
export async function acquireIngestionRun(options: {
  recoverStaleBefore?: Date;
  mode?: IngestionMode;
} = {}): Promise<IngestionRunAcquisition> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INGESTION_RUN_LOCK_KEY})`);

    let recoveredRunIds: number[] = [];
    if (options.recoverStaleBefore) {
      const recoveredRuns = await tx
        .update(ingestionRunsTable)
        .set({
          status: "failed",
          finishedAt: new Date(),
          errorMessage: "Ingestion was recovered as stale before a scheduled run",
        })
        .where(
          and(
            inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
            lt(ingestionRunsTable.startedAt, options.recoverStaleBefore),
          ),
        )
        .returning({ id: ingestionRunsTable.id });
      recoveredRunIds = recoveredRuns.map((run) => run.id);
      if (recoveredRunIds.length > 0) {
        logger.warn({ runIds: recoveredRunIds }, "Recovered stale PBS ingestion runs before scheduled ingestion");
      }
    }

    const [activeRun] = await tx
      .select()
      .from(ingestionRunsTable)
      .where(inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES))
      .orderBy(desc(ingestionRunsTable.startedAt))
      .limit(1);

    if (activeRun) return { activeRun, recoveredRunIds };

    const [run] = await tx
      .insert(ingestionRunsTable)
      .values({ status: "queued", mode: options.mode ?? "current" })
      .returning();
    if (!run) throw new Error("Unable to create an ingestion run");
    return { run, recoveredRunIds };
  });
}

export async function recoverInterruptedIngestionRuns(): Promise<void> {
  const recoveredRuns = await db
    .update(ingestionRunsTable)
    .set({
      status: "failed",
      finishedAt: new Date(),
      errorMessage: "Ingestion interrupted by an API server restart",
    })
    .where(inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES))
    .returning({ id: ingestionRunsTable.id });

  if (recoveredRuns.length > 0) {
    logger.warn(
      { runIds: recoveredRuns.map((run) => run.id) },
      "Recovered interrupted PBS ingestion runs",
    );
  }
}