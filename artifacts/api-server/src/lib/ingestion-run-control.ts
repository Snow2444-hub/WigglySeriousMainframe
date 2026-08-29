import { db, ingestionRunsTable, rawScheduleStagingTable, type IngestionRun } from "@workspace/db";
import { and, asc, desc, eq, inArray, like, lt, not, or, sql } from "drizzle-orm";
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

type IngestionRunOptions = {
  recoverStaleBefore?: Date;
  mode?: IngestionMode;
  scheduleDate?: string;
  maxPages?: number;
  excludeActiveRunIds?: number[];
};

/**
 * Serialises manual and scheduled starts and optionally retires runs left
 * active by a process that was terminated before it could update its status.
 */
export async function acquireIngestionRun(options: IngestionRunOptions = {}): Promise<IngestionRunAcquisition> {
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

    const activeRunPredicate = options.excludeActiveRunIds?.length
      ? and(
          inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
          not(inArray(ingestionRunsTable.id, options.excludeActiveRunIds)),
        )
      : inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES);
    const [activeRun] = await tx
      .select()
      .from(ingestionRunsTable)
      .where(activeRunPredicate)
      .orderBy(desc(ingestionRunsTable.startedAt))
      .limit(1);

    if (activeRun) return { activeRun, recoveredRunIds };

    const [run] = await tx
      .insert(ingestionRunsTable)
      .values({
        status: "queued",
        mode: options.mode ?? "current",
        ...(options.scheduleDate === undefined ? {} : { scheduleDate: options.scheduleDate }),
        ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      })
      .returning();
    if (!run) throw new Error("Unable to create an ingestion run");
    return { run, recoveredRunIds };
  });
}

export async function recoverInterruptedIngestionRuns(runIds?: number[]): Promise<IngestionRun[]> {
  const restartFailure = "Ingestion interrupted by an API server restart";
  const runIdFilter = runIds && runIds.length > 0 ? inArray(ingestionRunsTable.id, runIds) : undefined;
  const interruptedState = or(
    inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
    and(eq(ingestionRunsTable.status, "failed"), eq(ingestionRunsTable.errorMessage, restartFailure)),
  );
  const interruptedRuns = await db
    .select()
    .from(ingestionRunsTable)
    .where(runIdFilter ? and(runIdFilter, interruptedState) : interruptedState)
    .orderBy(asc(ingestionRunsTable.startedAt));

  const recoveredRuns: IngestionRun[] = [];
  for (const run of interruptedRuns) {
    let scheduleDate = run.scheduleDate;
    if (!scheduleDate) {
      const [stagedPage] = await db
        .select({ scheduleDate: rawScheduleStagingTable.scheduleDate })
        .from(rawScheduleStagingTable)
        .where(like(rawScheduleStagingTable.requestKey, `%:run-${run.id}`))
        .orderBy(asc(rawScheduleStagingTable.id))
        .limit(1);
      scheduleDate = stagedPage?.scheduleDate ?? run.startedAt.toISOString().slice(0, 10);
    }

    const [recoveredRun] = await db
      .update(ingestionRunsTable)
      .set({
        status: "queued",
        finishedAt: null,
        errorMessage: null,
        scheduleDate,
      })
      .where(eq(ingestionRunsTable.id, run.id))
      .returning();
    if (recoveredRun) recoveredRuns.push(recoveredRun);
  }

  if (recoveredRuns.length > 0) {
    logger.warn(
      { runIds: recoveredRuns.map((run) => run.id) },
      "Queued interrupted PBS ingestion runs for resume",
    );
  }
  return recoveredRuns;
}