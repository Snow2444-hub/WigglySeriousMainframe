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
  const match = requestKey.match(/schedule-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function oneYearBefore(dateValue: string): string {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const [itemPages, schedulePages] = await Promise.all([
    db
      .select({
        requestKey: rawScheduleStagingTable.requestKey,
        payload: rawScheduleStagingTable.payload,
      })
      .from(rawScheduleStagingTable)
      .where(eq(rawScheduleStagingTable.endpoint, "items"))
      .orderBy(asc(rawScheduleStagingTable.id)),
    db
      .select({ payload: rawScheduleStagingTable.payload })
      .from(rawScheduleStagingTable)
      .where(eq(rawScheduleStagingTable.endpoint, "schedules"))
      .orderBy(asc(rawScheduleStagingTable.id)),
  ]);

  const effectiveDates = new Map<number, string>();
  for (const page of schedulePages) {
    for (const record of recordsFromPayload(page.payload)) {
      const scheduleCode = numberField(record, "schedule_code");
      const effectiveDate = record.effective_date;
      if (
        scheduleCode !== undefined &&
        typeof effectiveDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
      ) {
        effectiveDates.set(scheduleCode, effectiveDate);
      }
    }
  }

  const stagedSchedules = new Map<
    string,
    { scheduleCode: number; effectiveDate: string; itemMetadata: PbsItemScheduleMetadata }
  >();
  for (const page of itemPages) {
    for (const record of recordsFromPayload(page.payload)) {
      const scheduleCode = numberField(record, "schedule_code") ?? scheduleCodeFromRequestKey(page.requestKey);
      const effectiveDate = scheduleCode === undefined ? undefined : effectiveDates.get(scheduleCode);
      if (scheduleCode === undefined || !effectiveDate) continue;
      const key = `${scheduleCode}:${effectiveDate}`;
      const schedule = stagedSchedules.get(key) ?? {
        scheduleCode,
        effectiveDate,
        itemMetadata: new Map(),
      };
      for (const [itemId, metadata] of itemScheduleMetadataFromPayload({ data: [record] })) {
        schedule.itemMetadata.set(itemId, metadata);
      }
      stagedSchedules.set(key, schedule);
    }
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