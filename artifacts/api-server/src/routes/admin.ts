import { Router, type IRouter } from "express";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, ingestionRunsTable } from "@workspace/db";
import {
  GetCurrentAdminIngestionRunResponse,
  ListAdminIngestionRunsResponse,
  TriggerAdminIngestionResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { fetchSchedule } from "../lib/pbs-ingestion";
import { requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();
const ACTIVE_STATUSES = ["queued", "running"] as const;
const INGESTION_RUN_LOCK_KEY = 502_668_451;

function currentScheduleDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function executeIngestionRun(runId: number, scheduleDate: string): Promise<void> {
  try {
    await db
      .update(ingestionRunsTable)
      .set({ status: "running" })
      .where(eq(ingestionRunsTable.id, runId));

    let recordsProcessed = 0;
    const pages = await fetchSchedule({
      scheduleDate,
      onPage: async (page) => {
        recordsProcessed += page.records;
        await db
          .update(ingestionRunsTable)
          .set({ recordsProcessed })
          .where(eq(ingestionRunsTable.id, runId));
      },
    });

    await db
      .update(ingestionRunsTable)
      .set({
        status: "completed",
        finishedAt: new Date(),
        recordsProcessed,
      })
      .where(eq(ingestionRunsTable.id, runId));

    logger.info({ runId, pages: pages.length, recordsProcessed }, "PBS ingestion run completed");
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

router.post("/admin/ingestion-runs", requireAdmin, async (_req, res): Promise<void> => {
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
  void executeIngestionRun(run.id, scheduleDate);
  res.status(202).json(TriggerAdminIngestionResponse.parse(run));
});

export default router;