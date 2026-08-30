import { db, ingestionRunsTable, rawScheduleStagingTable, type IngestionRun } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, lt, not, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { numberField, recordsFromPayload, stringField } from "./pbs-item-mapping";
import { scheduleCodeFromRequestKey } from "./schedule-changes";
import {
  isAuthoritativeStagedSnapshot,
  stagedRunIdFromRequestKey,
} from "./staged-snapshot-validity";
import { runtimeAuthorityScope } from "@workspace/db";

export const ACTIVE_INGESTION_STATUSES = ["queued", "running"] as const;
export const INGESTION_RUN_LOCK_KEY = 502_668_451;
export const DEFAULT_INGESTION_STALE_MINUTES = 15;
export const INGESTION_STALE_MINUTES_ENV = "PBS_INGESTION_STALE_MINUTES";
export const INGESTION_STALE_ERROR = "Ingestion marked stale after no page progress";
export const DEFAULT_STAGING_RETENTION_HOURS = 48;
export const STAGING_RETENTION_HOURS_ENV = "PBS_STAGING_RETENTION_HOURS";
export const INGESTION_CANCELLED_ERROR = "Ingestion cancelled by administrator";
const RESTART_INTERRUPTED_ERROR = "Ingestion interrupted by an API server restart";
type IngestionMode = "current" | "backfill";

export class IngestionCancelledError extends Error {
  constructor() {
    super(INGESTION_CANCELLED_ERROR);
    this.name = "IngestionCancelledError";
  }
}

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
    const authorityScope = runtimeAuthorityScope();

    let recoveredRunIds: number[] = [];
    const cancellationRequestedRuns = await tx
      .select({ id: ingestionRunsTable.id })
      .from(ingestionRunsTable)
      .where(
        and(
          inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
          eq(ingestionRunsTable.authorityScope, authorityScope),
          isNotNull(ingestionRunsTable.cancelRequestedAt),
        ),
      );
    for (const run of cancellationRequestedRuns) {
      await tx
        .delete(rawScheduleStagingTable)
        .where(like(rawScheduleStagingTable.requestKey, `%:run-${run.id}`));
      await tx
        .update(ingestionRunsTable)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          lastProgressAt: new Date(),
          errorMessage: INGESTION_CANCELLED_ERROR,
          snapshotComplete: false,
        })
        .where(
          and(
            eq(ingestionRunsTable.id, run.id),
            inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
            eq(ingestionRunsTable.authorityScope, authorityScope),
            isNotNull(ingestionRunsTable.cancelRequestedAt),
          ),
        );
    }
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
            eq(ingestionRunsTable.authorityScope, authorityScope),
            isNull(ingestionRunsTable.cancelRequestedAt),
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
          eq(ingestionRunsTable.authorityScope, authorityScope),
          not(inArray(ingestionRunsTable.id, options.excludeActiveRunIds)),
        )
      : and(inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES), eq(ingestionRunsTable.authorityScope, authorityScope));
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
        authorityScope,
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
  const authorityScope = runtimeAuthorityScope();
  const runIdFilter = runIds && runIds.length > 0 ? inArray(ingestionRunsTable.id, runIds) : undefined;
  const cancellationRequestedRuns = await db
    .select({ id: ingestionRunsTable.id })
    .from(ingestionRunsTable)
    .where(
      runIdFilter
        ? and(runIdFilter, eq(ingestionRunsTable.authorityScope, authorityScope), inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES), isNotNull(ingestionRunsTable.cancelRequestedAt))
        : and(eq(ingestionRunsTable.authorityScope, authorityScope), inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES), isNotNull(ingestionRunsTable.cancelRequestedAt)),
    );
  for (const run of cancellationRequestedRuns) {
    await finalizeCancelledIngestionRun(run.id);
  }

  const interruptedState = or(
    and(inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES), isNull(ingestionRunsTable.cancelRequestedAt)),
    and(eq(ingestionRunsTable.status, "failed"), eq(ingestionRunsTable.errorMessage, RESTART_INTERRUPTED_ERROR)),
  );
  const interruptedRuns = await db
    .select()
    .from(ingestionRunsTable)
    .where(runIdFilter ? and(runIdFilter, eq(ingestionRunsTable.authorityScope, authorityScope), interruptedState) : and(eq(ingestionRunsTable.authorityScope, authorityScope), interruptedState))
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
      .where(and(eq(ingestionRunsTable.id, run.id), eq(ingestionRunsTable.authorityScope, authorityScope)))
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
    const authorityScope = runtimeAuthorityScope();
    const cancellationRequestedRuns = await tx
      .select()
      .from(ingestionRunsTable)
      .where(
        and(
          inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
          eq(ingestionRunsTable.authorityScope, authorityScope),
          isNotNull(ingestionRunsTable.cancelRequestedAt),
        ),
      );
    for (const run of cancellationRequestedRuns) {
      await tx
        .delete(rawScheduleStagingTable)
        .where(like(rawScheduleStagingTable.requestKey, `%:run-${run.id}`));
      await tx
        .update(ingestionRunsTable)
        .set({
          status: "cancelled",
          finishedAt: recoveredAt,
          lastProgressAt: recoveredAt,
          errorMessage: INGESTION_CANCELLED_ERROR,
          snapshotComplete: false,
        })
        .where(
          and(
            eq(ingestionRunsTable.id, run.id),
            eq(ingestionRunsTable.authorityScope, authorityScope),
            inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
            isNotNull(ingestionRunsTable.cancelRequestedAt),
          ),
        );
    }
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
            eq(ingestionRunsTable.authorityScope, authorityScope),
            isNull(ingestionRunsTable.cancelRequestedAt),
          lt(
            sql`coalesce(${ingestionRunsTable.lastProgressAt}, ${ingestionRunsTable.startedAt})`,
            staleBefore,
          ),
        ),
      )
      .returning();
    if (cancellationRequestedRuns.length > 0) {
      logger.info(
        { runIds: cancellationRequestedRuns.map((run) => run.id) },
        "Finalized cancellation-requested PBS ingestion runs",
      );
    }
    if (staleRuns.length > 0) {
      logger.warn(
        { runIds: staleRuns.map((run) => run.id), staleBefore },
        "Retired stalled PBS ingestion runs",
      );
    }
    return [...cancellationRequestedRuns.map((run) => ({ ...run, status: "cancelled" })), ...staleRuns];
  });
}

export async function isIngestionRunCancelRequested(runId: number): Promise<boolean> {
  const [run] = await db
    .select({ cancelRequestedAt: ingestionRunsTable.cancelRequestedAt, status: ingestionRunsTable.status })
    .from(ingestionRunsTable)
    .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())))
    .limit(1);
  return Boolean(run?.cancelRequestedAt) || run?.status === "cancelled";
}

export async function throwIfIngestionRunCancelled(runId: number): Promise<void> {
  if (await isIngestionRunCancelRequested(runId)) throw new IngestionCancelledError();
}

export async function beginIngestionChangeDetection(runId: number): Promise<void> {
  const [startedRun] = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INGESTION_RUN_LOCK_KEY})`);
    return tx
      .update(ingestionRunsTable)
      .set({ changeDetectionStartedAt: new Date() })
      .where(
        and(
          eq(ingestionRunsTable.id, runId),
          eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope()),
          eq(ingestionRunsTable.status, "running"),
          isNull(ingestionRunsTable.cancelRequestedAt),
          isNull(ingestionRunsTable.changeDetectionStartedAt),
        ),
      )
      .returning({ id: ingestionRunsTable.id });
  });
  if (!startedRun) throw new IngestionCancelledError();
}

export async function finalizeCancelledIngestionRun(runId: number): Promise<IngestionRun | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INGESTION_RUN_LOCK_KEY})`);
    const [run] = await tx
      .select()
      .from(ingestionRunsTable)
      .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())))
      .limit(1);
    if (!run) return undefined;
    if (run.status === "cancelled") return run;
    if (!ACTIVE_INGESTION_STATUSES.includes(run.status as (typeof ACTIVE_INGESTION_STATUSES)[number])) return run;
    if (!run.cancelRequestedAt) return run;

    await tx
      .delete(rawScheduleStagingTable)
      .where(like(rawScheduleStagingTable.requestKey, `%:run-${runId}`));
    const [cancelledRun] = await tx
      .update(ingestionRunsTable)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        lastProgressAt: new Date(),
        errorMessage: INGESTION_CANCELLED_ERROR,
        snapshotComplete: false,
      })
      .where(
        and(
          eq(ingestionRunsTable.id, runId),
          eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope()),
          inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
          isNotNull(ingestionRunsTable.cancelRequestedAt),
        ),
      )
      .returning();
    return cancelledRun;
  });
}

export type IngestionCancellationRequestResult =
  | { kind: "cancelled"; run: IngestionRun }
  | { kind: "requested"; run: IngestionRun }
  | { kind: "terminal"; run: IngestionRun };

export async function requestIngestionRunCancellation(
  runId: number,
): Promise<IngestionCancellationRequestResult | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INGESTION_RUN_LOCK_KEY})`);
    const [run] = await tx
      .select()
      .from(ingestionRunsTable)
      .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())))
      .limit(1);
    if (!run) return undefined;
    if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
      return { kind: "terminal", run };
    }
    if (run.status === "queued") {
      await tx
        .delete(rawScheduleStagingTable)
        .where(like(rawScheduleStagingTable.requestKey, `%:run-${runId}`));
      const [cancelledRun] = await tx
        .update(ingestionRunsTable)
        .set({
          status: "cancelled",
          cancelRequestedAt: run.cancelRequestedAt ?? new Date(),
          finishedAt: new Date(),
          lastProgressAt: new Date(),
          errorMessage: INGESTION_CANCELLED_ERROR,
          snapshotComplete: false,
        })
        .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope()), eq(ingestionRunsTable.status, "queued")))
        .returning();
      if (cancelledRun) return { kind: "cancelled", run: cancelledRun };
    }
    const [requestedRun] = await tx
      .update(ingestionRunsTable)
      .set({ cancelRequestedAt: run.cancelRequestedAt ?? new Date() })
      .where(
        and(
          eq(ingestionRunsTable.id, runId),
          eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope()),
          inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES),
          isNull(ingestionRunsTable.cancelRequestedAt),
        ),
      )
      .returning();
    if (requestedRun) return { kind: "requested", run: requestedRun };
    const [currentRun] = await tx
      .select()
      .from(ingestionRunsTable)
      .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())))
      .limit(1);
    return currentRun ? { kind: currentRun.status === "cancelled" ? "cancelled" : "requested", run: currentRun } : undefined;
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

/**
 * Deletes raw PBS staging pages that are no longer needed: not part of an
 * active or restart-recoverable run, past the retention grace period, and
 * not the single most recent complete schedule snapshot for their endpoint
 * (which the next ingestion run needs to diff against). `schedules` rows are
 * tiny and never pruned, since they're needed to resolve schedule_code to
 * effective_date for whatever snapshots are retained.
 */
export async function pruneRawScheduleStaging(
  options: {
    retentionHours?: number;
    now?: Date;
    futureHorizonMonths?: number;
    scheduleCodes?: number[];
  } = {},
): Promise<{ deletedRows: number }> {
  const retentionHours = options.retentionHours ?? configuredStagingRetentionHours();
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);
  const authorityScope = runtimeAuthorityScope();

  const ingestionRuns = await db
    .select({
      id: ingestionRunsTable.id,
      status: ingestionRunsTable.status,
      errorMessage: ingestionRunsTable.errorMessage,
    })
    .from(ingestionRunsTable)
    .where(eq(ingestionRunsTable.authorityScope, authorityScope));
  const ingestionRunIds = new Set(ingestionRuns.map((run) => run.id));
  const protectedRunIds = new Set(
    ingestionRuns
      .filter(
        (run) =>
          ACTIVE_INGESTION_STATUSES.includes(run.status as (typeof ACTIVE_INGESTION_STATUSES)[number])
          || (run.status === "failed" && run.errorMessage === RESTART_INTERRUPTED_ERROR),
      )
      .map((run) => run.id),
  );

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

  const scheduleCodeFilter = options.scheduleCodes?.length
    ? or(...options.scheduleCodes.map((scheduleCode) =>
        like(rawScheduleStagingTable.requestKey, `%schedule-${scheduleCode}%`)
      ))
    : undefined;
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
    .where(
      scheduleCodeFilter
        ? and(not(eq(rawScheduleStagingTable.endpoint, "schedules")), scheduleCodeFilter)
        : not(eq(rawScheduleStagingTable.endpoint, "schedules")),
    );

  const latestEffectiveDateByEndpoint = new Map<string, string>();
  for (const row of candidateRows) {
    if (row.coverageScope !== "schedule" || !row.coverageComplete) continue;
    const scheduleCode = scheduleCodeFromRequestKey(row.requestKey);
    const effectiveDate = scheduleCode === undefined ? undefined : effectiveDates.get(scheduleCode);
    if (!effectiveDate) continue;
    if (
      !isAuthoritativeStagedSnapshot({
        requestKey: row.requestKey,
        effectiveDate,
        ingestionRunIds,
        now,
        futureHorizonMonths: options.futureHorizonMonths,
      })
    ) {
      continue;
    }
    const current = latestEffectiveDateByEndpoint.get(row.endpoint);
    if (!current || effectiveDate > current) latestEffectiveDateByEndpoint.set(row.endpoint, effectiveDate);
  }

  const idsToDelete: number[] = [];
  for (const row of candidateRows) {
    const runId = stagedRunIdFromRequestKey(row.requestKey);
    if (runId !== undefined && protectedRunIds.has(runId)) continue;
    if (row.fetchedAt >= cutoff) continue;
    if (row.coverageScope === "schedule" && row.coverageComplete) {
      const scheduleCode = scheduleCodeFromRequestKey(row.requestKey);
      const effectiveDate = scheduleCode === undefined ? undefined : effectiveDates.get(scheduleCode);
      const latest = latestEffectiveDateByEndpoint.get(row.endpoint);
      const authoritative =
        effectiveDate !== undefined
        && isAuthoritativeStagedSnapshot({
          requestKey: row.requestKey,
          effectiveDate,
          ingestionRunIds,
          now,
          futureHorizonMonths: options.futureHorizonMonths,
        });
      if (authoritative && latest && effectiveDate === latest) continue;
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