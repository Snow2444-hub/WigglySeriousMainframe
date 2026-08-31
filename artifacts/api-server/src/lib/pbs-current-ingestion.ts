import { and, asc, eq, isNull } from "drizzle-orm";
import {
  db,
  ingestionRunsTable,
  pbsWatchlistTable,
  runtimeAuthorityScope,
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
import {
  beginIngestionChangeDetection,
  finalizeCancelledIngestionRun,
  IngestionCancelledError,
  isIngestionRunCancelRequested,
  pruneRawScheduleStaging,
  throwIfIngestionRunCancelled,
} from "./ingestion-run-control";
import { syncScheduleChangesFromStagedData } from "./schedule-changes";
import {
  isCanonicalCurrentSnapshot,
  reconcilePbsItemCatalogueStatus,
} from "./pbs-item-lifecycle";
import { recalculatePredictedReductionsForDrug } from "./predicted-reductions";
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

    const [startedRun] = await db
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
      .where(
        and(
          eq(ingestionRunsTable.id, runId),
          eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope()),
          eq(ingestionRunsTable.status, "queued"),
          isNull(ingestionRunsTable.cancelRequestedAt),
        ),
      )
      .returning({ id: ingestionRunsTable.id });
    if (!startedRun) {
      await throwIfIngestionRunCancelled(runId);
      throw new Error(`PBS ingestion run ${runId} was not available to start`);
    }
    await throwIfIngestionRunCancelled(runId);

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
    const snapshotItemCodes = new Set<string>();
    const itemMetadata: PbsItemScheduleMetadata = new Map();
    const persistProgress = async () => {
      await db
        .update(ingestionRunsTable)
        .set({ pagesFetched, lastProgressAt: new Date(), requestUrls: [...requestUrls], recordsProcessed })
        .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
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
      shouldCancel: () => isIngestionRunCancelRequested(runId),
      onPayload: async (page) => {
        if (page.endpoint !== "schedules") return;
        const metadata = scheduleMetadataFromPayload(page.payload);
        scheduleEffectiveDate = metadata?.effectiveDate ?? scheduleEffectiveDate;
        scheduleCode = metadata?.scheduleCode ?? scheduleCode;
        await persistProgress();
      },
    });
    await throwIfIngestionRunCancelled(runId);
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
            shouldCancel: () => isIngestionRunCancelRequested(runId),
            onPayload: async (page) => {
              if (page.endpoint === "item-atc-relationships") {
                itemIdsFromAtcRelationshipPayload(page.payload).forEach((itemId) => atcItemIds.add(itemId));
              }
              await persistProgress();
            },
          });
    await throwIfIngestionRunCancelled(runId);

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
            shouldCancel: () => isIngestionRunCancelRequested(runId),
            onPayload: async (page) => {
              if (page.endpoint !== "items") return;
              if (!scheduleEffectiveDate) {
                throw new Error("Latest PBS schedule metadata did not include an effective_date");
              }
               for (const record of recordsFromPayload(page.payload)) {
                 const itemCode = stringField(record, "li_item_id");
                 if (itemCode) snapshotItemCodes.add(itemCode);
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
                    { authorityRunId: runId },
                );
                for (const [itemId, metadata] of itemScheduleMetadataFromPayload({ data: matched })) {
                  itemMetadata.set(itemId, metadata);
                }
              }
              await persistProgress();
            },
          });
    await throwIfIngestionRunCancelled(runId);

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
            shouldCancel: () => isIngestionRunCancelRequested(runId),
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
    await throwIfIngestionRunCancelled(runId);

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
    let changesRecorded = 0;
    if (!pageCapReached) {
      if (
        scheduleCode !== undefined
        && scheduleEffectiveDate !== undefined
        && isCanonicalCurrentSnapshot({ scheduleCode, effectiveDate: scheduleEffectiveDate, snapshotItemCodes })
      ) {
        const reconciliation = await reconcilePbsItemCatalogueStatus({
          scheduleCode,
          effectiveDate: scheduleEffectiveDate,
          snapshotItemCodes,
        });
        await Promise.all(
          reconciliation.affectedDrugIds.map((drugId) =>
            recalculatePredictedReductionsForDrug(drugId, undefined, runId),
          ),
        );
        logger.info(
          {
            runId,
            scheduleCode,
            effectiveDate: scheduleEffectiveDate,
            delistedCount: reconciliation.delistedItemCodes.length,
            reactivatedCount: reconciliation.reactivatedItemCodes.length,
          },
          "PBS catalogue lifecycle reconciled from complete current snapshot",
        );
      } else {
        logger.warn(
          { runId, scheduleCode, effectiveDate: scheduleEffectiveDate, snapshotItemCount: snapshotItemCodes.size },
          "Skipped PBS catalogue lifecycle reconciliation because the current snapshot was not canonical",
        );
      }
      await beginIngestionChangeDetection(runId);
      changesRecorded = await syncScheduleChangesImpl({ authorityRunId: runId });
    }
    if (pageCapReached) {
      logger.warn({ runId, maxPages }, "Skipped schedule-change detection because the page cap was reached");
    } else {
      await pruneRawScheduleStagingImpl().catch((error) => {
        logger.error({ err: error, runId }, "Failed to prune raw PBS schedule staging after ingestion");
      });
    }
    await throwIfIngestionRunCancelled(runId);
    const publishedFiles = await ingestPublishedFilesImpl(runId);

    await throwIfIngestionRunCancelled(runId);
    const [completedRun] = await db
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
      .where(
        and(
          eq(ingestionRunsTable.id, runId),
          eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope()),
          eq(ingestionRunsTable.status, "running"),
          isNull(ingestionRunsTable.cancelRequestedAt),
        ),
      )
      .returning({ id: ingestionRunsTable.id });
    if (!completedRun) {
      await throwIfIngestionRunCancelled(runId);
      throw new Error(`PBS ingestion run ${runId} could not be completed`);
    }

    logger.info(
      { runId, pages: pages.length, recordsProcessed, changesRecorded, publishedFiles, requestUrls: [...requestUrls] },
      "PBS ingestion run completed",
    );
  } catch (error) {
    if (error instanceof IngestionCancelledError || await isIngestionRunCancelRequested(runId)) {
      await finalizeCancelledIngestionRun(runId);
      logger.info({ runId }, "PBS ingestion run cancelled");
      return;
    }
    const errorMessage = error instanceof Error ? error.message : "Unknown ingestion error";
    await db
      .update(ingestionRunsTable)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: errorMessage.slice(0, 2_000),
      })
      .where(
        and(
          eq(ingestionRunsTable.id, runId),
          eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope()),
          eq(ingestionRunsTable.status, "running"),
          isNull(ingestionRunsTable.cancelRequestedAt),
        ),
      );
    logger.error({ err: error, runId }, "PBS ingestion run failed");
  }
}
