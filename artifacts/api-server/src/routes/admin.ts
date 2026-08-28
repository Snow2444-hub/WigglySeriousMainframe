import { raw, Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  artgEntriesTable,
  artgIngestionRunsTable,
  db,
  drugsTable,
  ingestionRunsTable,
  pbsItemsTable,
  pbsWatchlistTable,
} from "@workspace/db";
import {
  CreatePbsWatchlistEntryBody,
  CreatePbsWatchlistEntryResponse,
  DeletePbsWatchlistEntryParams,
  GetScheduleChangeSettingsResponse,
  GetCurrentAdminIngestionRunResponse,
  ListAdminPublishedFilesResponse,
  ListPbsWatchlistEntriesResponse,
  ListAdminIngestionRunsResponse,
  ListAdminArtgImportRunsResponse,
  TriggerAdminIngestionBody,
  TriggerAdminIngestionResponse,
  UploadAdminArtgExportResponse,
  UpdateScheduleChangeSettingsBody,
  UpdateScheduleChangeSettingsResponse,
  UpdatePbsWatchlistEntryBody,
  UpdatePbsWatchlistEntryParams,
  UpdatePbsWatchlistEntryResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { fetchSchedule } from "../lib/pbs-ingestion";
import {
  buildPbsItemDispensingRuleRequestFilters,
  buildPbsItemIdRequestFilters,
  buildPbsRequestFilters,
} from "../lib/pbs-filtering";
import {
  itemIdsFromAtcRelationshipPayload,
  itemScheduleMetadataFromPayload,
  upsertPbsItemPremiumsFromPayload,
  upsertPbsItemsFromPayload,
  type PbsItemScheduleMetadata,
} from "../lib/pbs-item-mapping";
import { ingestPublishedFiles, listLatestPublishedFiles } from "../lib/pbs-published-files";
import {
  getPriceChangeThresholds,
  syncScheduleChangesFromStagedData,
  updatePriceChangeThresholds,
} from "../lib/schedule-changes";
import {
  ARTG_PARSER_VERSION,
  parseArtgExport,
  pbsBrandMatchesArtgProduct,
  shouldReplaceLegacySeedRecords,
} from "../lib/artg-import";
import { requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();
const ACTIVE_STATUSES = ["queued", "running"] as const;
const INGESTION_RUN_LOCK_KEY = 502_668_451;
const ARTG_UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;

function currentScheduleDate(): string {
  return new Date().toISOString().slice(0, 10);
}

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

type IngestionMode = "current" | "backfill";

export async function executeIngestionRun(
  runId: number,
  scheduleDate: string,
  maxPages?: number,
  mode: IngestionMode = "current",
): Promise<void> {
  if (mode === "backfill") {
    await executeBackfillIngestionRun(runId, scheduleDate, maxPages);
    return;
  }

  try {
    await db
      .update(ingestionRunsTable)
      .set({ status: "running" })
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
        itemIdsFromAtcRelationshipPayload(page.payload).forEach((itemId) => atcItemIds.add(itemId));
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
      logger.warn({ runId, maxPages }, "Skipped schedule-change detection because the ingestion page cap was reached");
    }
    const publishedFiles = await ingestPublishedFiles();

    await db
      .update(ingestionRunsTable)
      .set({
        status: "completed",
        finishedAt: new Date(),
        recordsProcessed,
        pagesFetched: pages.length,
        requestUrls: [...requestUrls],
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

interface HistoricalSchedule {
  scheduleCode: number;
  effectiveDate: string;
}

function historicalSchedulesFromPayload(payload: unknown): HistoricalSchedule[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((record) => {
    if (typeof record !== "object" || record === null) return [];
    const value = record as { schedule_code?: unknown; effective_date?: unknown };
    const scheduleCode =
      typeof value.schedule_code === "number"
        ? value.schedule_code
        : typeof value.schedule_code === "string"
          ? Number(value.schedule_code)
          : NaN;
    const effectiveDate = value.effective_date;
    if (
      !Number.isInteger(scheduleCode) ||
      typeof effectiveDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
    ) {
      return [];
    }
    return [{ scheduleCode, effectiveDate }];
  });
}

function dateOneYearBefore(dateValue: string): string {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

async function executeBackfillIngestionRun(
  runId: number,
  scheduleDate: string,
  maxPages?: number,
): Promise<void> {
  try {
    await db
      .update(ingestionRunsTable)
      .set({ status: "running" })
      .where(eq(ingestionRunsTable.id, runId));

    const enabledWatchlist = await db
      .select()
      .from(pbsWatchlistTable)
      .where(eq(pbsWatchlistTable.enabled, true))
      .orderBy(asc(pbsWatchlistTable.id));
    const filters = buildPbsRequestFilters(enabledWatchlist);
    if (filters.length === 0) {
      throw new Error("No enabled PBS watchlist entries are configured; refusing to backfill an unfiltered schedule");
    }

    let recordsProcessed = 0;
    let recordsReturned = 0;
    let pagesFetched = 0;
    const requestUrls = new Set<string>();
    const schedules: HistoricalSchedule[] = [];
    const persistProgress = async () => {
      await db
        .update(ingestionRunsTable)
        .set({ pagesFetched, requestUrls: [...requestUrls], recordsProcessed })
        .where(eq(ingestionRunsTable.id, runId));
    };

    const schedulePages = await fetchSchedule({
      scheduleDate,
      endpoints: ["schedules"],
      limit: 100,
      maxPages,
      latestScheduleOnly: false,
      filters: [{ requestKey: `backfill-schedules:${runId}`, params: {} }],
      onPage: async (page) => {
        pagesFetched += 1;
        requestUrls.add(page.url);
        await persistProgress();
      },
      onPayload: ({ payload }) => {
        schedules.push(...historicalSchedulesFromPayload(payload));
      },
    });

    const latestEffectiveDate = schedules
      .map((schedule) => schedule.effectiveDate)
      .sort((left, right) => right.localeCompare(left))[0];
    if (!latestEffectiveDate) {
      throw new Error("PBS backfill schedule metadata did not include any effective dates");
    }
    const cutoffDate = dateOneYearBefore(latestEffectiveDate);
    const uniqueSchedules = [...new Map(
      schedules
        .filter((schedule) => schedule.effectiveDate >= cutoffDate && schedule.effectiveDate <= latestEffectiveDate)
        .map((schedule) => [`${schedule.scheduleCode}:${schedule.effectiveDate}`, schedule]),
    ).values()].sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));

    if (uniqueSchedules.length === 0) {
      throw new Error(`PBS backfill returned no schedules in the 12-month window beginning ${cutoffDate}`);
    }

    for (const schedule of uniqueSchedules) {
      const remainingPages = maxPages === undefined ? undefined : maxPages - pagesFetched;
      if (remainingPages === 0) break;

      const scheduleFilters = filters.map((filter) => ({
        ...filter,
        requestKey: `${filter.requestKey}:schedule-${schedule.scheduleCode}`,
        params: { ...filter.params, schedule_code: String(schedule.scheduleCode) },
      }));
      const scheduleItemIds = new Set<string>();
      const itemMetadata: PbsItemScheduleMetadata = new Map();
      const handlePage = async (page: { endpoint: string; url: string; records: number }) => {
        pagesFetched += 1;
        requestUrls.add(page.url);
        if (page.endpoint === "items") recordsReturned += page.records;
        await persistProgress();
      };
      const handlePayload = async (page: { endpoint: string; payload: unknown }) => {
        if (page.endpoint === "item-atc-relationships") {
          itemIdsFromAtcRelationshipPayload(page.payload).forEach((itemId) => scheduleItemIds.add(itemId));
        }
        if (page.endpoint === "items") {
          itemIdsFromAtcRelationshipPayload(page.payload).forEach((itemId) => scheduleItemIds.add(itemId));
          for (const [itemId, metadata] of itemScheduleMetadataFromPayload(page.payload)) {
            itemMetadata.set(itemId, metadata);
          }
          recordsProcessed += await upsertPbsItemsFromPayload(
            page.payload,
            scheduleDate,
            schedule.effectiveDate,
            {
              scheduleCode: schedule.scheduleCode,
              updateCurrentItem: schedule.effectiveDate === latestEffectiveDate,
            },
          );
        }
        if (page.endpoint === "item-dispensing-rule-relationships") {
          recordsProcessed += await upsertPbsItemPremiumsFromPayload(
            page.payload,
            schedule.effectiveDate,
            itemMetadata,
            schedule.scheduleCode,
          );
        }
        await persistProgress();
      };

      const itemPages = await fetchSchedule({
        scheduleDate,
        latestScheduleOnly: false,
        maxPages: remainingPages,
        filters: scheduleFilters,
        onPage: handlePage,
        onPayload: handlePayload,
      });
      const pagesAfterItems = remainingPages === undefined ? undefined : remainingPages - itemPages.length;
      const snapshotPages =
        pagesAfterItems === 0
          ? []
          : await fetchSchedule({
              scheduleDate,
              endpoints: ["items"],
              latestScheduleOnly: false,
              maxPages: pagesAfterItems,
              filters: [{ requestKey: `items-snapshot:schedule-${schedule.scheduleCode}`, params: {} }],
              coverageScope: "schedule",
              stagingRunId: runId,
              onPage: async (page) => {
                pagesFetched += 1;
                requestUrls.add(page.url);
                await persistProgress();
              },
            });
      const pagesLeft = pagesAfterItems === undefined ? undefined : pagesAfterItems - snapshotPages.length;
      const relatedFilters = pagesLeft === 0
        ? []
        : buildPbsItemIdRequestFilters(scheduleItemIds).map((filter) => ({
            ...filter,
            requestKey: `${filter.requestKey}:schedule-${schedule.scheduleCode}`,
            params: { ...filter.params, schedule_code: String(schedule.scheduleCode) },
          }));
      const relatedItemPages = relatedFilters.length > 0
        ? await fetchSchedule({
          scheduleDate,
          latestScheduleOnly: false,
          maxPages: pagesLeft,
          filters: relatedFilters,
          onPage: handlePage,
          onPayload: handlePayload,
        })
        : [];
      const pagesLeftForPremiums =
        pagesLeft === undefined ? undefined : pagesLeft - relatedItemPages.length;
      const premiumFilters =
        pagesLeftForPremiums === 0
          ? []
          : buildPbsItemDispensingRuleRequestFilters(itemMetadata.keys()).map((filter) => ({
              ...filter,
              requestKey: `${filter.requestKey}:schedule-${schedule.scheduleCode}`,
              params: { ...filter.params, schedule_code: String(schedule.scheduleCode) },
            }));
      if (premiumFilters.length > 0) {
        await fetchSchedule({
          scheduleDate,
          latestScheduleOnly: false,
          maxPages: pagesLeftForPremiums,
          filters: premiumFilters,
          onPage: handlePage,
          onPayload: handlePayload,
        });
      }
    }

    if (recordsReturned > 0 && recordsProcessed === 0) {
      throw new Error(`PBS backfill returned ${recordsReturned} item records, but 0 were mapped; all records were skipped because required PBS item fields were unavailable or invalid`);
    }
    const pageCapReached = maxPages !== undefined && pagesFetched >= maxPages;
    const changesRecorded = pageCapReached ? 0 : await syncScheduleChangesFromStagedData();
    if (pageCapReached) {
      logger.warn({ runId, maxPages }, "Skipped schedule-change detection because the backfill page cap was reached");
    }

    await db
      .update(ingestionRunsTable)
      .set({
        status: "completed",
        finishedAt: new Date(),
        recordsProcessed,
        pagesFetched,
        requestUrls: [...requestUrls],
      })
      .where(eq(ingestionRunsTable.id, runId));

    logger.info(
      {
        runId,
        schedules: uniqueSchedules.length,
        pages: pagesFetched,
        recordsProcessed,
        changesRecorded,
        requestUrls: [...requestUrls],
      },
      "PBS backfill ingestion run completed",
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown ingestion error";
    await db
      .update(ingestionRunsTable)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: errorMessage.slice(0, 2_000) })
      .where(eq(ingestionRunsTable.id, runId));
    logger.error({ err: error, runId }, "PBS backfill ingestion run failed");
  }
}

export async function recoverInterruptedIngestionRuns(): Promise<void> {
  const recoveredRuns = await db
    .update(ingestionRunsTable)
    .set({
      status: "failed",
      finishedAt: new Date(),
      errorMessage: "Ingestion interrupted by an API server restart",
    })
    .where(inArray(ingestionRunsTable.status, ACTIVE_STATUSES))
    .returning({ id: ingestionRunsTable.id });

  if (recoveredRuns.length > 0) {
    logger.warn(
      { runIds: recoveredRuns.map((run) => run.id) },
      "Recovered interrupted PBS ingestion runs",
    );
  }
}

router.get("/admin/ingestion-runs", requireAdmin, async (_req, res): Promise<void> => {
  const runs = await db
    .select()
    .from(ingestionRunsTable)
    .orderBy(desc(ingestionRunsTable.startedAt))
    .limit(25);

  res.json(ListAdminIngestionRunsResponse.parse(runs));
});

router.get("/admin/ingestion-runs/current", requireAdmin, async (_req, res): Promise<void> => {
  const [run] = await db
    .select()
    .from(ingestionRunsTable)
    .where(inArray(ingestionRunsTable.status, ACTIVE_STATUSES))
    .orderBy(desc(ingestionRunsTable.startedAt))
    .limit(1);

  res.json(GetCurrentAdminIngestionRunResponse.parse({ currentRun: run ?? null }));
});

function uploadFileName(value: string | undefined): string {
  const decoded = value ? decodeURIComponent(value) : "unknown-artg-export";
  return decoded.replace(/[\\/\0]/g, "_").slice(0, 255) || "unknown-artg-export";
}

function uploadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The ARTG upload could not be processed.";
}

router.get("/admin/artg-imports", requireAdmin, async (_req, res): Promise<void> => {
  const runs = await db
    .select()
    .from(artgIngestionRunsTable)
    .orderBy(desc(artgIngestionRunsTable.startedAt))
    .limit(25);
  res.json(ListAdminArtgImportRunsResponse.parse(runs));
});

router.post(
  "/admin/artg-imports",
  requireAdmin,
  raw({ type: () => true, limit: "16mb" }),
  async (req, res): Promise<void> => {
    const sourceFileName = uploadFileName(req.header("x-artg-file-name") ?? undefined);
    const contentType = req.header("content-type") ?? null;
    const upload = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const fileSha256 = createHash("sha256").update(upload).digest("hex");
    const [run] = await db
      .insert(artgIngestionRunsTable)
      .values({
        sourceFileName,
        contentType,
        fileSha256,
        parserVersion: ARTG_PARSER_VERSION,
        status: "running",
      })
      .returning();

    try {
      if (!upload.length) throw new Error("The uploaded ARTG file was empty.");
      if (upload.length > ARTG_UPLOAD_LIMIT_BYTES) {
        throw new Error("The ARTG export exceeds the 15 MB upload limit.");
      }
      const drugs = await db
        .select({
          id: drugsTable.id,
          name: drugsTable.name,
          activeIngredient: drugsTable.activeIngredient,
        })
        .from(drugsTable);
      const parsed = parseArtgExport(upload, sourceFileName, drugs);
      const drugIds = [...new Set(parsed.records.map((record) => record.matchedDrugId))];
      const pbsBrands = drugIds.length
        ? await db
          .select({ drugId: pbsItemsTable.drugId, brandName: pbsItemsTable.brandName })
          .from(pbsItemsTable)
          .where(inArray(pbsItemsTable.drugId, drugIds))
        : [];
      const brandsByDrug = new Map<number, string[]>();
      for (const row of pbsBrands) {
        brandsByDrug.set(row.drugId, [...(brandsByDrug.get(row.drugId) ?? []), row.brandName]);
      }
      const pbsUnlistedRecords = parsed.records.filter((record) =>
        !(brandsByDrug.get(record.matchedDrugId) ?? []).some((brand) =>
          pbsBrandMatchesArtgProduct(record.productName, brand),
        ),
      ).length;

      const completed = await db.transaction(async (tx) => {
        if (shouldReplaceLegacySeedRecords(parsed.recordsAccepted)) {
          await tx.delete(artgEntriesTable).where(eq(artgEntriesTable.source, "legacy_seed"));
          await tx
            .insert(artgEntriesTable)
            .values(parsed.records.map((record) => ({
              ...record,
              source: "manual_upload",
              ingestionRunId: run.id,
            })))
            .onConflictDoUpdate({
              target: artgEntriesTable.artgId,
              set: {
                activeIngredient: sql`excluded.active_ingredient`,
                normalizedIngredient: sql`excluded.normalized_ingredient`,
                matchedDrugId: sql`excluded.matched_drug_id`,
                sponsor: sql`excluded.sponsor`,
                registrationDate: sql`excluded.registration_date`,
                productName: sql`excluded.product_name`,
                status: sql`excluded.status`,
                source: sql`excluded.source`,
                ingestionRunId: sql`excluded.ingestion_run_id`,
              },
            });
        }
        const [result] = await tx
          .update(artgIngestionRunsTable)
          .set({
            status: "completed",
            rowsRead: parsed.rowsRead,
            recordsAccepted: parsed.recordsAccepted,
            recordsRejected: parsed.recordsRejected,
            recordsSkipped: parsed.recordsSkipped,
            matchedDrugRecords: parsed.matchedDrugRecords,
            pbsUnlistedRecords,
            warnings: parsed.warnings,
            finishedAt: new Date(),
          })
          .where(eq(artgIngestionRunsTable.id, run.id))
          .returning();
        return result;
      });
      req.log.info(
        {
          runId: completed.id,
          rowsRead: completed.rowsRead,
          accepted: completed.recordsAccepted,
          rejected: completed.recordsRejected,
          skipped: completed.recordsSkipped,
          pbsUnlistedRecords,
        },
        "Manual ARTG import completed",
      );
      res.json(UploadAdminArtgExportResponse.parse(completed));
    } catch (error) {
      const errorMessage = uploadErrorMessage(error).slice(0, 2_000);
      const [failed] = await db
        .update(artgIngestionRunsTable)
        .set({ status: "failed", finishedAt: new Date(), errorMessage })
        .where(eq(artgIngestionRunsTable.id, run.id))
        .returning();
      req.log.error({ err: error, runId: run.id }, "Manual ARTG import failed");
      res.status(400).json({ error: errorMessage, run: failed });
    }
  },
);

router.get("/admin/published-files", requireAdmin, async (_req, res): Promise<void> => {
  res.json(ListAdminPublishedFilesResponse.parse(await listLatestPublishedFiles()));
});

router.get("/admin/pbs-watchlist", requireAdmin, async (_req, res): Promise<void> => {
  const entries = await db.select().from(pbsWatchlistTable).orderBy(asc(pbsWatchlistTable.id));
  res.json(ListPbsWatchlistEntriesResponse.parse(entries));
});

router.get("/admin/schedule-change-settings", requireAdmin, async (_req, res): Promise<void> => {
  res.json(GetScheduleChangeSettingsResponse.parse(await getPriceChangeThresholds()));
});

router.patch("/admin/schedule-change-settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateScheduleChangeSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.mediumReductionPercentage >= parsed.data.highReductionPercentage) {
    res.status(400).json({
      error: "Medium reduction percentage must be lower than the high reduction percentage",
    });
    return;
  }
  const settings = await updatePriceChangeThresholds(parsed.data);
  res.json(UpdateScheduleChangeSettingsResponse.parse(settings));
});

router.post("/admin/pbs-watchlist", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreatePbsWatchlistEntryBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid PBS watchlist entry");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db.insert(pbsWatchlistTable).values(parsed.data).returning();
  res.status(201).json(CreatePbsWatchlistEntryResponse.parse(created));
});

router.patch("/admin/pbs-watchlist/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdatePbsWatchlistEntryParams.safeParse(req.params);
  const body = UpdatePbsWatchlistEntryBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [updated] = await db
    .update(pbsWatchlistTable)
    .set(body.data)
    .where(eq(pbsWatchlistTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "PBS watchlist entry not found" });
    return;
  }
  res.json(UpdatePbsWatchlistEntryResponse.parse(updated));
});

router.delete("/admin/pbs-watchlist/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeletePbsWatchlistEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(pbsWatchlistTable)
    .where(eq(pbsWatchlistTable.id, params.data.id))
    .returning({ id: pbsWatchlistTable.id });
  if (!deleted) {
    res.status(404).json({ error: "PBS watchlist entry not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/admin/ingestion-runs", requireAdmin, async (req, res): Promise<void> => {
  const parsedBody = TriggerAdminIngestionBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }

  const acquisition = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INGESTION_RUN_LOCK_KEY})`);

    const [activeRun] = await tx
      .select()
      .from(ingestionRunsTable)
      .where(inArray(ingestionRunsTable.status, ACTIVE_STATUSES))
      .orderBy(desc(ingestionRunsTable.startedAt))
      .limit(1);

    if (activeRun) return { activeRun };

    const [run] = await tx
      .insert(ingestionRunsTable)
      .values({ status: "queued" })
      .returning();

    if (!run) throw new Error("Unable to create an ingestion run");
    return { run };
  });

  if ("activeRun" in acquisition) {
    res.status(409).json({ error: "An ingestion run is already in progress" });
    return;
  }

  const { run } = acquisition;
  const scheduleDate = currentScheduleDate();
  void executeIngestionRun(
    run.id,
    scheduleDate,
    parsedBody.data.maxPages,
    parsedBody.data.mode ?? "current",
  );
  res.status(202).json(TriggerAdminIngestionResponse.parse(run));
});

export default router;