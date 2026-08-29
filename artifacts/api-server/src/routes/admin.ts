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
import { listLatestPublishedFiles } from "../lib/pbs-published-files";
import { executeCurrentIngestionRun } from "../lib/pbs-current-ingestion";
import {
  getPriceChangeThresholds,
  syncScheduleChangesFromStagedData,
  updatePriceChangeThresholds,
} from "../lib/schedule-changes";
import {
  ACTIVE_INGESTION_STATUSES,
  acquireIngestionRun,
  currentScheduleDate,
} from "../lib/ingestion-run-control";
import {
  ARTG_PARSER_VERSION,
  parseArtgExport,
  pbsBrandMatchesArtgProduct,
  shouldReplaceLegacySeedRecords,
} from "../lib/artg-import";
import { requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();
const ARTG_UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;

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
  await executeCurrentIngestionRun(runId, scheduleDate, maxPages);
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
      .set({
        status: "running",
        mode: "backfill",
        scheduleDate,
        maxPages: maxPages ?? null,
        totalSchedules: null,
        schedulesProcessed: 0,
      })
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
    let totalSchedules: number | null = null;
    let schedulesProcessed = 0;
    const requestUrls = new Set<string>();
    const schedules: HistoricalSchedule[] = [];
    const persistProgress = async () => {
      await db
        .update(ingestionRunsTable)
        .set({
          pagesFetched,
          requestUrls: [...requestUrls],
          recordsProcessed,
          totalSchedules,
          schedulesProcessed,
        })
        .where(eq(ingestionRunsTable.id, runId));
    };

    const schedulePages = await fetchSchedule({
      scheduleDate,
      endpoints: ["schedules"],
      limit: 100,
      maxPages,
      latestScheduleOnly: false,
      filters: [{ requestKey: `backfill-schedules:${runId}`, params: {} }],
        stagingRunId: runId,
        resumeFromStaging: true,
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
    totalSchedules = uniqueSchedules.length;
    await persistProgress();

    for (const [scheduleIndex, schedule] of uniqueSchedules.entries()) {
      const remainingPages = maxPages === undefined ? undefined : maxPages - pagesFetched;
      if (remainingPages === 0) break;
      await persistProgress();

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
        stagingRunId: runId,
        resumeFromStaging: true,
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
              resumeFromStaging: true,
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
           stagingRunId: runId,
           resumeFromStaging: true,
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
          stagingRunId: runId,
          resumeFromStaging: true,
          onPage: handlePage,
          onPayload: handlePayload,
        });
      }
      schedulesProcessed = scheduleIndex + 1;
      await persistProgress();
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
        totalSchedules,
        schedulesProcessed,
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
    .where(inArray(ingestionRunsTable.status, ACTIVE_INGESTION_STATUSES))
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

  const scheduleDate = currentScheduleDate();
  const mode = parsedBody.data.mode ?? "current";
  const acquisition = await acquireIngestionRun({
    mode,
    scheduleDate,
    maxPages: parsedBody.data.maxPages,
  });

  if ("activeRun" in acquisition) {
    res.status(409).json({ error: "An ingestion run is already in progress" });
    return;
  }

  const { run } = acquisition;
  void executeIngestionRun(
    run.id,
    scheduleDate,
    run.maxPages ?? undefined,
    run.mode === "backfill" ? "backfill" : "current",
  );
  res.status(202).json(TriggerAdminIngestionResponse.parse(run));
});

export default router;