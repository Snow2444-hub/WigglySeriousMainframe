import { db, ingestionRunsTable, rawScheduleStagingTable, type IngestionRun } from "@workspace/db";
import { and, asc, desc, eq, inArray, like, lt, not, or, sql } from "drizzle-orm";
import { logger } from "./logger";

export const ACTIVE_INGESTION_STATUSES = ["queued", "running"] as const;
export const INGESTION_RUN_LOCK_KEY = 502_668_451;
export const DEFAULT_INGESTION_STALE_MINUTES = 15;
export const INGESTION_STALE_MINUTES_ENV = "PBS_INGESTION_STALE_MINUTES";
export const INGESTION_STALE_ERROR = "Ingestion marked stale after no page progress";
type IngestionMode = "current" | "backfill";

export type IngestionRunAcquisition =
  | { run: IngestionRun; activeRun?: never; recoveredRunIds: number[] }
  | { run?: never; activeRun: IngestionRun; recoveredRunIds: number[] };

export function currentScheduleDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function configuredIngestionStaleMinutes(): number {
  const rawValue = process.env[INGESTION_STALE_MINUTES_ENV];
  if (rawValue === undefined || rawValue.trim() === "") return DEFAULT_INGESTION_STALE_MINUTES;
  const staleMinutes = Number(rawValue);
  if (Number.isInteger(staleMinutes) && staleMinutes > 0) return staleMinutes;
  logger.warn(
    { envVar: INGESTION_STALE_MINUTES_ENV, value: rawValue, fallback: DEFAULT_INGESTION_STALE_MINUTES },
    "Invalid PBS ingestion stale threshold; using the default",
  );
  return DEFAULT_INGESTION_STALE_MINUTES;
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
            lt(
              sql`coalesce(${ingestionRunsTable.lastProgressAt}, ${ingestionRunsTable.startedAt})`,
              options.recoverStaleBefore,
            ),
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
        lastProgressAt: new Date(),
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

export async function recoverStaleIngestionRuns(
  staleBefore = new Date(Date.now() - configuredIngestionStaleMinutes() * 60_000),
): Promise<IngestionRun[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INGESTION_RUN_LOCK_KEY})`);
    const recoveredAt = new Date();
    const staleRuns = await tx
      .update(ingestionRunsTable)
      .set({
        status: "failed",
        lastProgressAt: recoveredAt,
        finishedAt: recoveredAt,
        errorMessage: INGESTION_STALE_ERROR,
      })
      .where(
        and(
          inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
          lt(
            sql`coalesce(${ingestionRunsTable.lastProgressAt}, ${ingestionRunsTable.startedAt})`,
            staleBefore,
          ),
        ),
      )
      .returning();
    if (staleRuns.length > 0) {
      logger.warn(
        { runIds: staleRuns.map((run) => run.id), staleBefore },
        "Retired stalled PBS ingestion runs",
      );
    }
    return staleRuns;
  });
}