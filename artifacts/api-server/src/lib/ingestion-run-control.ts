import { db, ingestionRunsTable, rawScheduleStagingTable, type IngestionRun } from "@workspace/db";
import { and, asc, desc, eq, inArray, like, lt, not, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { numberField, recordsFromPayload, stringField } from "./pbs-item-mapping";
import { scheduleCodeFromRequestKey } from "./schedule-changes";

export const ACTIVE_INGESTION_STATUSES = ["queued", "running"] as const;
export const INGESTION_RUN_LOCK_KEY = 502_668_451;
export const DEFAULT_INGESTION_STALE_MINUTES = 15;
export const INGESTION_STALE_MINUTES_ENV = "PBS_INGESTION_STALE_MINUTES";
export const INGESTION_STALE_ERROR = "Ingestion marked stale after no page progress";
export const DEFAULT_STAGING_RETENTION_HOURS = 48;
export const STAGING_RETENTION_HOURS_ENV = "PBS_STAGING_RETENTION_HOURS";
const RESTART_INTERRUPTED_ERROR = "Ingestion interrupted by an API server restart";
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
  const runIdFilter = runIds && runIds.length > 0 ? inArray(ingestionRunsTable.id, runIds) : undefined;
  const interruptedState = or(
    inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
    and(eq(ingestionRunsTable.status, "failed"), eq(ingestionRunsTable.errorMessage, RESTART_INTERRUPTED_ERROR)),
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

export function configuredStagingRetentionHours(): number {
  const rawValue = process.env[STAGING_RETENTION_HOURS_ENV];
  if (rawValue === undefined || rawValue.trim() === "") return DEFAULT_STAGING_RETENTION_HOURS;
  const retentionHours = Number(rawValue);
  if (Number.isInteger(retentionHours) && retentionHours > 0) return retentionHours;
  logger.warn(
    { envVar: STAGING_RETENTION_HOURS_ENV, value: rawValue, fallback: DEFAULT_STAGING_RETENTION_HOURS },
    "Invalid PBS staging retention threshold; using the default",
  );
  return DEFAULT_STAGING_RETENTION_HOURS;
}

function runIdFromRequestKey(requestKey: string): number | undefined {
  const match = /:run-(\d+)$/.exec(requestKey);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : undefined;
}

/**
 * Deletes raw PBS staging pages that are no longer needed: not part of an
 * active or restart-recoverable run, past the retention grace period, and
 * not the single most recent complete schedule snapshot for their endpoint
 * (which the next ingestion run needs to diff against). `schedules` rows are
 * tiny and never pruned, since they're needed to resolve schedule_code to
 * effective_date for whatever snapshots are retained.
 */
export async function pruneRawScheduleStaging(
  options: { retentionHours?: number; now?: Date } = {},
): Promise<{ deletedRows: number }> {
  const retentionHours = options.retentionHours ?? configuredStagingRetentionHours();
  const cutoff = new Date((options.now ?? new Date()).getTime() - retentionHours * 60 * 60 * 1000);

  const protectedRuns = await db
    .select({ id: ingestionRunsTable.id })
    .from(ingestionRunsTable)
    .where(
      or(
        inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
        and(eq(ingestionRunsTable.status, "failed"), eq(ingestionRunsTable.errorMessage, RESTART_INTERRUPTED_ERROR)),
      ),
    );
  const protectedRunIds = new Set(protectedRuns.map((run) => run.id));

  const scheduleRows = await db
    .select({ payload: rawScheduleStagingTable.payload })
    .from(rawScheduleStagingTable)
    .where(eq(rawScheduleStagingTable.endpoint, "schedules"));
  const effectiveDates = new Map<number, string>();
  for (const row of scheduleRows) {
    for (const record of recordsFromPayload(row.payload)) {
      const scheduleCode = numberField(record, "schedule_code");
      const effectiveDate = stringField(record, "effective_date");
      if (scheduleCode !== undefined && effectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
        effectiveDates.set(scheduleCode, effectiveDate);
      }
    }
  }

  const candidateRows = await db
    .select({
      id: rawScheduleStagingTable.id,
      endpoint: rawScheduleStagingTable.endpoint,
      requestKey: rawScheduleStagingTable.requestKey,
      coverageScope: rawScheduleStagingTable.coverageScope,
      coverageComplete: rawScheduleStagingTable.coverageComplete,
      fetchedAt: rawScheduleStagingTable.fetchedAt,
    })
    .from(rawScheduleStagingTable)
    .where(not(eq(rawScheduleStagingTable.endpoint, "schedules")));

  const latestEffectiveDateByEndpoint = new Map<string, string>();
  for (const row of candidateRows) {
    if (row.coverageScope !== "schedule" || !row.coverageComplete) continue;
    const scheduleCode = scheduleCodeFromRequestKey(row.requestKey);
    const effectiveDate = scheduleCode === undefined ? undefined : effectiveDates.get(scheduleCode);
    if (!effectiveDate) continue;
    const current = latestEffectiveDateByEndpoint.get(row.endpoint);
    if (!current || effectiveDate > current) latestEffectiveDateByEndpoint.set(row.endpoint, effectiveDate);
  }

  const idsToDelete: number[] = [];
  for (const row of candidateRows) {
    const runId = runIdFromRequestKey(row.requestKey);
    if (runId !== undefined && protectedRunIds.has(runId)) continue;
    if (row.fetchedAt >= cutoff) continue;
    if (row.coverageScope === "schedule" && row.coverageComplete) {
      const scheduleCode = scheduleCodeFromRequestKey(row.requestKey);
      const effectiveDate = scheduleCode === undefined ? undefined : effectiveDates.get(scheduleCode);
      const latest = latestEffectiveDateByEndpoint.get(row.endpoint);
      if (effectiveDate && latest && effectiveDate === latest) continue;
    }
    idsToDelete.push(row.id);
  }

  let deletedRows = 0;
  for (let start = 0; start < idsToDelete.length; start += 500) {
    const chunk = idsToDelete.slice(start, start + 500);
    const deleted = await db
      .delete(rawScheduleStagingTable)
      .where(inArray(rawScheduleStagingTable.id, chunk))
      .returning({ id: rawScheduleStagingTable.id });
    deletedRows += deleted.length;
  }
  if (deletedRows > 0) {
    logger.info({ deletedRows, retentionHours }, "Pruned raw PBS schedule staging");
  }
  return { deletedRows };
}