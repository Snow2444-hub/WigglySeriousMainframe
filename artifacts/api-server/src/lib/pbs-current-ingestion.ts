import { asc, eq } from "drizzle-orm";
import {
  db,
  ingestionRunsTable,
  pbsWatchlistTable,
} from "@workspace/db";
import { logger } from "./logger";
import { fetchSchedule } from "./pbs-ingestion";
import {
  buildAtcWatchlistFilters,
  buildDirectWatchlistMatchers,
  recordMatchesWatchlist,
} from "./pbs-filtering";
import {
  itemIdsFromAtcRelationshipPayload,
  itemScheduleMetadataFromPayload,
  recordsFromPayload,
  stringField,
  upsertPbsItemPremiumsFromPayload,
  upsertPbsItemsFromPayload,
  type PbsItemScheduleMetadata,
} from "./pbs-item-mapping";
import { ingestPublishedFiles } from "./pbs-published-files";
import { pruneRawScheduleStaging } from "./ingestion-run-control";
import { syncScheduleChangesFromStagedData } from "./schedule-changes";
import type { PbsIngestionExecutorDependencies } from "./pbs-ingestion-executor-dependencies";

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
  dependencies: PbsIngestionExecutorDependencies = {},
): Promise<void> {
  try {
    const fetchScheduleImpl = dependencies.fetchSchedule ?? fetchSchedule;
    const syncScheduleChangesImpl =
      dependencies.syncScheduleChangesFromStagedData ?? syncScheduleChangesFromStagedData;
    const pruneRawScheduleStagingImpl = dependencies.pruneRawScheduleStaging ?? pruneRawScheduleStaging;
    const ingestPublishedFilesImpl = dependencies.ingestPublishedFiles ?? ingestPublishedFiles;

    await db
      .update(ingestionRunsTable)
      .set({
        status: "running",
        lastProgressAt: new Date(),
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
    const directMatchers = buildDirectWatchlistMatchers(enabledWatchlist);
    const atcFilters = buildAtcWatchlistFilters(enabledWatchlist);
    if (directMatchers.length === 0 && atcFilters.length === 0) {
      throw new Error("No enabled PBS watchlist entries are configured; refusing to fetch an unfiltered schedule");
    }

    let recordsProcessed = 0;
    let recordsReturned = 0;
    let recordsMatched = 0;
    let scheduleEffectiveDate: string | undefined;
    let scheduleCode: number | undefined;
    let pagesFetched = 0;
    const requestUrls = new Set<string>();
    const atcItemIds = new Set<string>();
    const itemMetadata: PbsItemScheduleMetadata = new Map();
    const persistProgress = async () => {
      await db
        .update(ingestionRunsTable)
        .set({ pagesFetched, lastProgressAt: new Date(), requestUrls: [...requestUrls], recordsProcessed })
        .where(eq(ingestionRunsTable.id, runId));
    };
    const handlePage = async (page: { endpoint: string; url: string; records: number }) => {
      requestUrls.add(page.url);
      pagesFetched += 1;
      if (page.endpoint === "items") recordsReturned += page.records;
      await persistProgress();
    };

    const schedulePages = await fetchScheduleImpl({
      scheduleDate,
      endpoints: ["schedules"],
      limit: 100,
      maxPages: 1,
      filters: [{ requestKey: `schedule-metadata:${runId}`, params: {} }],
      stagingRunId: runId,
      resumeFromStaging: true,
      onPage: handlePage,
      onPayload: async (page) => {
        if (page.endpoint !== "schedules") return;
        const metadata = scheduleMetadataFromPayload(page.payload);
        scheduleEffectiveDate = metadata?.effectiveDate ?? scheduleEffectiveDate;
        scheduleCode = metadata?.scheduleCode ?? scheduleCode;
        await persistProgress();
      },
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

    // Step 1 of the ATC path: a live, filtered relationship lookup per ATC
    // watchlist entry. Step 2 (resolving those IDs to full item records)
    // happens locally below against the full items snapshot instead of a
    // second live fetch, so an ATC-heavy watchlist no longer multiplies
    // fetch time.
    const atcPages =
      atcFilters.length === 0
        ? []
        : await fetchScheduleImpl({
            scheduleDate,
            maxPages: pagesAvailableAfterSchedule,
            filters: atcFilters,
            stagingRunId: runId,
            resumeFromStaging: true,
            onPage: handlePage,
            onPayload: async (page) => {
              if (page.endpoint === "item-atc-relationships") {
                itemIdsFromAtcRelationshipPayload(page.payload).forEach((itemId) => atcItemIds.add(itemId));
              }
              await persistProgress();
            },
          });

    const pagesAvailableForItems =
      pagesAvailableAfterSchedule === undefined ? undefined : pagesAvailableAfterSchedule - atcPages.length;
    const itemsPages =
      pagesAvailableForItems === 0
        ? []
        : await fetchScheduleImpl({
            scheduleDate,
            endpoints: ["items"],
            maxPages: pagesAvailableForItems,
            filters: [{ requestKey: `items-snapshot:schedule-${scheduleCode}`, params: {} }],
            coverageScope: "schedule",
            stagingRunId: runId,
            resumeFromStaging: true,
            onPage: handlePage,
            onPayload: async (page) => {
              if (page.endpoint !== "items") return;
              if (!scheduleEffectiveDate) {
                throw new Error("Latest PBS schedule metadata did not include an effective_date");
              }
              const matched = recordsFromPayload(page.payload).filter((record) =>
                recordMatchesWatchlist(record, directMatchers, atcItemIds),
              );
              recordsMatched += matched.length;
              if (matched.length > 0) {
                recordsProcessed += await upsertPbsItemsFromPayload(
                  { data: matched },
                  scheduleDate,
                  scheduleEffectiveDate,
                );
                for (const [itemId, metadata] of itemScheduleMetadataFromPayload({ data: matched })) {
                  itemMetadata.set(itemId, metadata);
                }
              }
              await persistProgress();
            },
          });

    const pagesAvailableForPremiums =
      pagesAvailableForItems === undefined ? undefined : pagesAvailableForItems - itemsPages.length;
    const premiumPages =
      pagesAvailableForPremiums === 0
        ? []
        : await fetchScheduleImpl({
            scheduleDate,
            endpoints: ["item-dispensing-rule-relationships"],
            maxPages: pagesAvailableForPremiums,
            filters: [{
              requestKey: `item-dispensing-rules-snapshot:schedule-${scheduleCode}`,
              params: {},
            }],
            coverageScope: "schedule",
            stagingRunId: runId,
            resumeFromStaging: true,
            onPage: handlePage,
            onPayload: async (page) => {
              if (page.endpoint !== "item-dispensing-rule-relationships") return;
              if (!scheduleEffectiveDate) {
                throw new Error("Latest PBS schedule metadata did not include an effective_date");
              }
              const matched = recordsFromPayload(page.payload).filter((record) => {
                const liItemId = stringField(record, "li_item_id");
                return liItemId !== undefined && itemMetadata.has(liItemId);
              });
              if (matched.length > 0) {
                recordsProcessed += await upsertPbsItemPremiumsFromPayload(
                  { data: matched },
                  scheduleEffectiveDate,
                  itemMetadata,
                  scheduleCode,
                );
              }
              await persistProgress();
            },
          });

    const pages = [...schedulePages, ...atcPages, ...itemsPages, ...premiumPages];
    if (recordsReturned > 0 && recordsMatched === 0) {
      logger.warn({ runId }, "PBS schedule snapshot returned records but none matched the configured watchlist");
    }
    if (recordsMatched > 0 && recordsProcessed === 0) {
      throw new Error(
        `PBS matched ${recordsMatched} watchlist records, but 0 were mapped; all records were skipped because required PBS item fields were unavailable or invalid`,
      );
    }
    const pageCapReached = maxPages !== undefined && pages.length >= maxPages;
    const changesRecorded = pageCapReached ? 0 : await syncScheduleChangesImpl();
    if (pageCapReached) {
      logger.warn({ runId, maxPages }, "Skipped schedule-change detection because the page cap was reached");
    } else {
      await pruneRawScheduleStagingImpl().catch((error) => {
        logger.error({ err: error, runId }, "Failed to prune raw PBS schedule staging after ingestion");
      });
    }
    const publishedFiles = await ingestPublishedFilesImpl(runId);

    await db
      .update(ingestionRunsTable)
      .set({
        scheduleCode,
        scheduleEffectiveDate,
        status: "completed",
        lastProgressAt: new Date(),
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
