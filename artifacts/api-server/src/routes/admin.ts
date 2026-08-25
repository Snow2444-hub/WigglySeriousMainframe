import { Router, type IRouter } from "express";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, ingestionRunsTable, pbsWatchlistTable } from "@workspace/db";
import {
  CreatePbsWatchlistEntryBody,
  CreatePbsWatchlistEntryResponse,
  DeletePbsWatchlistEntryParams,
  GetCurrentAdminIngestionRunResponse,
  ListPbsWatchlistEntriesResponse,
  ListAdminIngestionRunsResponse,
  TriggerAdminIngestionBody,
  TriggerAdminIngestionResponse,
  UpdatePbsWatchlistEntryBody,
  UpdatePbsWatchlistEntryParams,
  UpdatePbsWatchlistEntryResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { fetchSchedule } from "../lib/pbs-ingestion";
import { buildPbsItemIdRequestFilters, buildPbsRequestFilters } from "../lib/pbs-filtering";
import { itemIdsFromAtcRelationshipPayload, upsertPbsItemsFromPayload } from "../lib/pbs-item-mapping";
import { requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();
const ACTIVE_STATUSES = ["queued", "running"] as const;
const INGESTION_RUN_LOCK_KEY = 502_668_451;

function currentScheduleDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function executeIngestionRun(runId: number, scheduleDate: string, maxPages?: number): Promise<void> {
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
    let pagesFetched = 0;
    const requestUrls = new Set<string>();
    const atcItemIds = new Set<string>();
    const persistProgress = async () => {
      await db
        .update(ingestionRunsTable)
        .set({ pagesFetched, requestUrls: [...requestUrls], recordsProcessed })
        .where(eq(ingestionRunsTable.id, runId));
    };
    const handlePage = async (page: { url: string }) => {
      requestUrls.add(page.url);
      pagesFetched += 1;
      await persistProgress();
    };
    const handlePayload = async (page: { endpoint: string; payload: unknown }) => {
      if (page.endpoint === "item-atc-relationships") {
        itemIdsFromAtcRelationshipPayload(page.payload).forEach((itemId) => atcItemIds.add(itemId));
      }
      if (page.endpoint === "items") {
        recordsProcessed += await upsertPbsItemsFromPayload(page.payload, scheduleDate);
      }
      await persistProgress();
    };

    const initialPages = await fetchSchedule({
      scheduleDate,
      maxPages,
      filters,
      onPage: handlePage,
      onPayload: handlePayload,
    });
    const remainingPages = maxPages === undefined ? undefined : maxPages - initialPages.length;
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
    const pages = [...initialPages, ...relatedItemPages];

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
      { runId, pages: pages.length, recordsProcessed, requestUrls: [...requestUrls] },
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

router.get("/admin/pbs-watchlist", requireAdmin, async (_req, res): Promise<void> => {
  const entries = await db.select().from(pbsWatchlistTable).orderBy(asc(pbsWatchlistTable.id));
  res.json(ListPbsWatchlistEntriesResponse.parse(entries));
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
  void executeIngestionRun(run.id, scheduleDate, parsedBody.data.maxPages);
  res.status(202).json(TriggerAdminIngestionResponse.parse(run));
});

export default router;