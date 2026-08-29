import { asc, eq } from "drizzle-orm";
import { db, rawScheduleStagingTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { fetchSchedule } from "../lib/pbs-ingestion";
import { buildPbsItemDispensingRuleRequestFilters } from "../lib/pbs-filtering";
import {
  itemScheduleMetadataFromPayload,
  upsertPbsItemPremiumsFromPayload,
  type PbsItemScheduleMetadata,
} from "../lib/pbs-item-mapping";
import { syncScheduleChangesFromStagedData } from "../lib/schedule-changes";

// This is a legacy operational script. Running it against duplicated staged
// data without canonical run selection can pool runs and manufacture bad
// premium data. The canonical rule is highest numeric run per schedule/date.

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsFromPayload(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of ["data", "items", "results", "records"]) {
    if (Array.isArray(payload[key])) return payload[key].filter(isRecord);
  }
  return [];
}

function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function scheduleCodeFromRequestKey(requestKey: string): number | undefined {
  const match = requestKey.match(/schedule-(\d+)(?::run-\d+)?$/);
  return match ? Number(match[1]) : undefined;
}

function sourceRunIdFromRequestKey(requestKey: string): number {
  const match = requestKey.match(/:run-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function oneYearBefore(dateValue: string): string {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  if (process.env.PBS_PREMIUM_BACKFILL_CONFIRM !== "true") {
    throw new Error(
      "Refusing to run staged PBS premium backfill. Set PBS_PREMIUM_BACKFILL_CONFIRM=true to run it deliberately.",
    );
  }

  const [itemPages, schedulePages] = await Promise.all([
    db
      .select({
        id: rawScheduleStagingTable.id,
        requestKey: rawScheduleStagingTable.requestKey,
        coverageScope: rawScheduleStagingTable.coverageScope,
        coverageComplete: rawScheduleStagingTable.coverageComplete,
        payload: rawScheduleStagingTable.payload,
      })
      .from(rawScheduleStagingTable)
      .where(eq(rawScheduleStagingTable.endpoint, "items"))
      .orderBy(asc(rawScheduleStagingTable.id)),
    db
      .select({
        id: rawScheduleStagingTable.id,
        requestKey: rawScheduleStagingTable.requestKey,
        payload: rawScheduleStagingTable.payload,
      })
      .from(rawScheduleStagingTable)
      .where(eq(rawScheduleStagingTable.endpoint, "schedules"))
      .orderBy(asc(rawScheduleStagingTable.id)),
  ]);

  const effectiveDates = new Map<number, { effectiveDate: string; sourceRunId: number; rowId: number }>();
  for (const page of schedulePages) {
    for (const record of recordsFromPayload(page.payload)) {
      const scheduleCode = numberField(record, "schedule_code");
      const effectiveDate = record.effective_date;
      if (
        scheduleCode !== undefined &&
        typeof effectiveDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
      ) {
        const sourceRunId = sourceRunIdFromRequestKey(page.requestKey);
        const existing = effectiveDates.get(scheduleCode);
        if (
          !existing
          || sourceRunId > existing.sourceRunId
          || (sourceRunId === existing.sourceRunId && page.id > existing.rowId)
        ) {
          effectiveDates.set(scheduleCode, { effectiveDate, sourceRunId, rowId: page.id });
        }
      }
    }
  }

  const candidatePages: Array<{
    requestKey: string;
    payload: unknown;
    scheduleCode: number;
    effectiveDate: string;
    sourceRunId: number;
  }> = [];
  for (const page of itemPages) {
    if (page.coverageScope !== "schedule" || !page.coverageComplete) continue;
    const records = recordsFromPayload(page.payload);
    const firstRecord = records[0];
    const scheduleCode =
      (firstRecord && numberField(firstRecord, "schedule_code"))
      ?? scheduleCodeFromRequestKey(page.requestKey);
    const effectiveDateFromRecord = firstRecord?.effective_date;
    const effectiveDate =
      typeof effectiveDateFromRecord === "string" && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDateFromRecord)
        ? effectiveDateFromRecord
        : scheduleCode === undefined
          ? undefined
          : effectiveDates.get(scheduleCode)?.effectiveDate;
    if (scheduleCode === undefined || !effectiveDate) continue;
    candidatePages.push({
      requestKey: page.requestKey,
      payload: page.payload,
      scheduleCode,
      effectiveDate,
      sourceRunId: sourceRunIdFromRequestKey(page.requestKey),
    });
  }

  const highestRunBySchedule = new Map<string, number>();
  for (const page of candidatePages) {
    const key = `${page.scheduleCode}:${page.effectiveDate}`;
    const current = highestRunBySchedule.get(key);
    if (current === undefined || page.sourceRunId > current) {
      highestRunBySchedule.set(key, page.sourceRunId);
    }
  }

  const stagedSchedules = new Map<
    string,
    { scheduleCode: number; effectiveDate: string; itemMetadata: PbsItemScheduleMetadata }
  >();
  for (const page of candidatePages) {
    const key = `${page.scheduleCode}:${page.effectiveDate}`;
    if (highestRunBySchedule.get(key) !== page.sourceRunId) continue;
    const schedule = stagedSchedules.get(key) ?? {
      scheduleCode: page.scheduleCode,
      effectiveDate: page.effectiveDate,
      itemMetadata: new Map(),
    };
    for (const record of recordsFromPayload(page.payload)) {
      for (const [itemId, metadata] of itemScheduleMetadataFromPayload({ data: [record] })) {
          schedule.itemMetadata.set(itemId, metadata);
      }
    }
    stagedSchedules.set(key, schedule);
  }

  const allSchedules = [...stagedSchedules.values()].sort((left, right) =>
    left.effectiveDate.localeCompare(right.effectiveDate),
  );
  const latestEffectiveDate = allSchedules.at(-1)?.effectiveDate;
  if (!latestEffectiveDate) throw new Error("No staged PBS item schedules are available for premium backfill");
  const cutoff = oneYearBefore(latestEffectiveDate);
  const schedules = allSchedules.filter((schedule) => schedule.effectiveDate >= cutoff);
  const requestedScheduleLimit = Number(process.env.PBS_PREMIUM_BACKFILL_MAX_SCHEDULES);
  const requestedBatchLimit = Number(process.env.PBS_PREMIUM_BACKFILL_MAX_BATCHES);
  const schedulesToFetch =
    Number.isInteger(requestedScheduleLimit) && requestedScheduleLimit > 0
      ? schedules.slice(0, requestedScheduleLimit)
      : schedules;
  let recordsProcessed = 0;

  if (process.env.PBS_PREMIUM_SYNC_ONLY !== "true") {
    for (const schedule of schedulesToFetch) {
      const filters = buildPbsItemDispensingRuleRequestFilters(schedule.itemMetadata.keys())
      .map((filter) => ({
        ...filter,
        requestKey: `premium-backfill:${filter.requestKey}:schedule-${schedule.scheduleCode}`,
        params: { ...filter.params, schedule_code: String(schedule.scheduleCode) },
      }))
      .slice(
        0,
        Number.isInteger(requestedBatchLimit) && requestedBatchLimit > 0
          ? requestedBatchLimit
          : undefined,
      );
      if (filters.length === 0) continue;
      logger.info(
        {
          scheduleCode: schedule.scheduleCode,
          effectiveDate: schedule.effectiveDate,
          items: schedule.itemMetadata.size,
          requestBatches: filters.length,
        },
        "Backfilling PBS item premium relationships from staged schedule",
      );
      await fetchSchedule({
        scheduleDate: latestEffectiveDate,
        latestScheduleOnly: false,
        filters,
        onPayload: async (page) => {
          recordsProcessed += await upsertPbsItemPremiumsFromPayload(
            page.payload,
            schedule.effectiveDate,
            schedule.itemMetadata,
            schedule.scheduleCode,
          );
        },
      });
    }
  }

  const scheduleChangeSummary = await syncScheduleChangesFromStagedData();
  logger.info(
    { schedules: schedulesToFetch.length, recordsProcessed, scheduleChangeSummary },
    "Completed staged PBS premium history backfill and schedule-change sync",
  );
}

main().catch((error) => {
  logger.error({ err: error }, "PBS premium history backfill failed");
  process.exitCode = 1;
});