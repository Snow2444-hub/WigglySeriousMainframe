import { asc, eq } from "drizzle-orm";
import {
  db,
  ingestionRunsTable,
  pbsWatchlistTable,
} from "@workspace/db";
import { logger } from "./logger";
import { fetchSchedule } from "./pbs-ingestion";
import {
  buildPbsItemDispensingRuleRequestFilters,
  buildPbsItemIdRequestFilters,
  buildPbsRequestFilters,
} from "./pbs-filtering";
import {
  itemIdsFromAtcRelationshipPayload,
  itemScheduleMetadataFromPayload,
  upsertPbsItemPremiumsFromPayload,
  upsertPbsItemsFromPayload,
  type PbsItemScheduleMetadata,
} from "./pbs-item-mapping";
import { ingestPublishedFiles } from "./pbs-published-files";
import { syncScheduleChangesFromStagedData } from "./schedule-changes";

function scheduleMetadataFromPayload(payload: unknown): { scheduleCode?: number; effectiveDate?: string } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  for (const record of data) {
    if (typeof record !== "object" || record === null) continue;
    const value = record as { schedule_code?: unknown; effective_date?: unknown };
    const scheduleCode =
      typeof value.schedule_code === "number"
        ? value.schedule_code
        : typeof value.schedule_code === "string" && /^\d+$/.test(value.schedule_code)
          ? Number(value.schedule_code)
          : undefined;
    const effectiveDate =
      typeof value.effective_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.effective_date)
        ? value.effective_date
        : undefined;
    if (scheduleCode !== undefined || effectiveDate !== undefined) return { scheduleCode, effectiveDate };
  }
  return undefined;
}

export async function executeCurrentIngestionRun(
  runId: number,
  scheduleDate: string,
  maxPages?: number,
): Promise<void> {
  try {
    await db
      .update(ingestionRunsTable)
      .set({
        status: "running",
        mode: "current",
        scheduleDate,
        maxPages: maxPages ?? null,
        totalSchedules: null,
        schedulesProcessed: 0,
        snapshotComplete: false,
      })
      .where(eq(ingestionRunsTable.id, runId));

    const enabledWatchlist = await db
      .select()
      .from(pbsWatchlistTable)
      .where(eq(pbsWatchlistTable.enabled, true))
      .orderBy(asc(pbsWatchlistTable.id));
    const filters = buildPbsRequestFilters(enabledWatchlist);
    if (filters.length === 0) {
      throw new Error("No enabled PBS watchlist entries are configured; refusing to fetch an unfiltered schedule");
    }

    let recordsProcessed = 0;
    let recordsReturned = 0;
    let scheduleEffectiveDate: string | undefined;
    let scheduleCode: number | undefined;
    let pagesFetched = 0;
    const requestUrls = new Set<string>();
    const atcItemIds = new Set<string>();
    const itemMetadata: PbsItemScheduleMetadata = new Map();
    const persistProgress = async () => {
      await db
        .update(ingestionRunsTable)
        .set({ pagesFetched, requestUrls: [...requestUrls], recordsProcessed })
        .where(eq(ingestionRunsTable.id, runId));
    };
    const handlePage = async (page: { endpoint: string; url: string; records: number }) => {
      requestUrls.add(page.url);
      pagesFetched += 1;
      if (page.endpoint === "items") recordsReturned += page.records;
      await persistProgress();
    };
    const handlePayload = async (page: { endpoint: string; payload: unknown }) => {
      if (page.endpoint === "item-atc-relationships") {
        itemIdsFromAtcRelationshipPayload(page.payload).forEach((itemId) => atcItemIds.add(itemId));
      }
      if (page.endpoint === "items") {
        for (const [itemId, metadata] of itemScheduleMetadataFromPayload(page.payload)) {
          itemMetadata.set(itemId, metadata);
        }
      }
      if (page.endpoint === "schedules") {
        const metadata = scheduleMetadataFromPayload(page.payload);
        scheduleEffectiveDate = metadata?.effectiveDate ?? scheduleEffectiveDate;
        scheduleCode = metadata?.scheduleCode ?? scheduleCode;
      }
      if (page.endpoint === "items") {
        if (!scheduleEffectiveDate) {
          throw new Error("Latest PBS schedule metadata did not include an effective_date");
        }
        recordsProcessed += await upsertPbsItemsFromPayload(page.payload, scheduleDate, scheduleEffectiveDate);
      }
      if (page.endpoint === "item-dispensing-rule-relationships") {
        if (!scheduleEffectiveDate) {
          throw new Error("Latest PBS schedule metadata did not include an effective_date");
        }
        recordsProcessed += await upsertPbsItemPremiumsFromPayload(
          page.payload,
          scheduleEffectiveDate,
          itemMetadata,
        );
      }
      await persistProgress();
    };

    const schedulePages = await fetchSchedule({
      scheduleDate,
      endpoints: ["schedules"],
      limit: 100,
      maxPages: 1,
      filters: [{ requestKey: `schedule-metadata:${runId}`, params: {} }],
      stagingRunId: runId,
      resumeFromStaging: true,
      onPage: handlePage,
      onPayload: handlePayload,
    });
    if (!scheduleEffectiveDate) {
      throw new Error("Latest PBS schedule metadata did not include an effective_date");
    }
    if (scheduleCode === undefined) {
      throw new Error("Latest PBS schedule metadata did not include a schedule_code");
    }
    const pagesAvailableAfterSchedule = maxPages === undefined ? undefined : maxPages - schedulePages.length;
    if (pagesAvailableAfterSchedule !== undefined && pagesAvailableAfterSchedule <= 0) {
      throw new Error("maxPages was exhausted by schedule metadata before PBS item retrieval");
    }

    const initialPages = await fetchSchedule({
      scheduleDate,
      maxPages: pagesAvailableAfterSchedule,
      filters,
      stagingRunId: runId,
      resumeFromStaging: true,
      onPage: handlePage,
      onPayload: handlePayload,
    });
    const remainingPages =
      pagesAvailableAfterSchedule === undefined
        ? undefined
        : pagesAvailableAfterSchedule - initialPages.length;
    const itemIdFilters = remainingPages === 0 ? [] : buildPbsItemIdRequestFilters(atcItemIds);
    const relatedItemPages = itemIdFilters.length
      ? await fetchSchedule({
          scheduleDate,
          maxPages: remainingPages,
          filters: itemIdFilters,
          stagingRunId: runId,
          resumeFromStaging: true,
          onPage: handlePage,
          onPayload: handlePayload,
        })
      : [];
    const pagesAvailableForPremiums =
      pagesAvailableAfterSchedule === undefined
        ? undefined
        : pagesAvailableAfterSchedule - initialPages.length - relatedItemPages.length;
    const premiumFilters =
      pagesAvailableForPremiums === 0
        ? []
        : buildPbsItemDispensingRuleRequestFilters(itemMetadata.keys());
    const premiumPages = premiumFilters.length
      ? await fetchSchedule({
          scheduleDate,
          maxPages: pagesAvailableForPremiums,
          filters: premiumFilters,
          stagingRunId: runId,
          resumeFromStaging: true,
          onPage: handlePage,
          onPayload: handlePayload,
        })
      : [];
    const pagesAvailableForSnapshot =
      maxPages === undefined
        ? undefined
        : maxPages - schedulePages.length - initialPages.length - relatedItemPages.length - premiumPages.length;
    const snapshotPages =
      pagesAvailableForSnapshot === 0
        ? []
        : await fetchSchedule({
            scheduleDate,
            endpoints: ["items"],
            maxPages: pagesAvailableForSnapshot,
            filters: [{ requestKey: `items-snapshot:schedule-${scheduleCode}`, params: {} }],
            coverageScope: "schedule",
            stagingRunId: runId,
            resumeFromStaging: true,
            onPage: async (page) => {
              requestUrls.add(page.url);
              pagesFetched += 1;
              await persistProgress();
            },
          });
    const pages = [
      ...schedulePages,
      ...initialPages,
      ...relatedItemPages,
      ...premiumPages,
      ...snapshotPages,
    ];
    if (recordsReturned > 0 && recordsProcessed === 0) {
      throw new Error(`PBS returned ${recordsReturned} records, but 0 were mapped; all records were skipped because required PBS item fields were unavailable or invalid`);
    }
    const pageCapReached = maxPages !== undefined && pages.length >= maxPages;
    const changesRecorded = pageCapReached ? 0 : await syncScheduleChangesFromStagedData();
    if (pageCapReached) {
      logger.warn({ runId, maxPages }, "Skipped schedule-change detection because the page cap was reached");
    }
    const publishedFiles = await ingestPublishedFiles();

    await db
      .update(ingestionRunsTable)
      .set({
        scheduleCode,
        scheduleEffectiveDate,
        status: "completed",
        finishedAt: new Date(),
        recordsProcessed,
        pagesFetched: pages.length,
        requestUrls: [...requestUrls],
        snapshotComplete: !pageCapReached,
      })
      .where(eq(ingestionRunsTable.id, runId));

    logger.info(
      { runId, pages: pages.length, recordsProcessed, changesRecorded, publishedFiles, requestUrls: [...requestUrls] },
      "PBS ingestion run completed",
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown ingestion error";
    await db
      .update(ingestionRunsTable)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: errorMessage.slice(0, 2_000),
      })
      .where(eq(ingestionRunsTable.id, runId));
    logger.error({ err: error, runId }, "PBS ingestion run failed");
  }
}