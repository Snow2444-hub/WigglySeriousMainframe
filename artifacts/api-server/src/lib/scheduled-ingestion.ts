import { db, ingestionRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { executeCurrentIngestionRun } from "./pbs-current-ingestion";
import {
  acquireIngestionRun,
  currentScheduleDate,
} from "./ingestion-run-control";
import { logger } from "./logger";

type IngestionExecutor = (
  runId: number,
  scheduleDate: string,
  maxPages?: number,
) => Promise<void>;

export type ScheduledIngestionResult =
  | { status: "completed"; runId: number; recoveredRunIds: number[] }
  | { status: "skipped"; activeRunId: number; recoveredRunIds: number[] }
  | { status: "failed"; runId: number; errorMessage: string; recoveredRunIds: number[] };

const DEFAULT_STALE_RUN_MINUTES = 180;

export async function runScheduledIngestion(options: {
  now?: Date;
  scheduleDate?: string;
  staleRunMinutes?: number;
  execute?: IngestionExecutor;
} = {}): Promise<ScheduledIngestionResult> {
  const now = options.now ?? new Date();
  const staleRunMinutes = options.staleRunMinutes ?? DEFAULT_STALE_RUN_MINUTES;
  if (!Number.isInteger(staleRunMinutes) || staleRunMinutes <= 0) {
    throw new Error("staleRunMinutes must be a positive integer");
  }

  const acquisition = await acquireIngestionRun({
    recoverStaleBefore: new Date(now.getTime() - staleRunMinutes * 60_000),
  });
  if ("activeRun" in acquisition) {
    const activeRun = acquisition.activeRun;
    if (!activeRun) throw new Error("Active ingestion run was not returned by the acquisition check");
    logger.info(
      { runId: activeRun.id },
      "Skipped scheduled PBS ingestion because another run is active",
    );
    return {
      status: "skipped",
      activeRunId: activeRun.id,
      recoveredRunIds: acquisition.recoveredRunIds,
    };
  }

  const runId = acquisition.run.id;
  const execute = options.execute ?? executeCurrentIngestionRun;
  try {
    await execute(runId, options.scheduleDate ?? currentScheduleDate());
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown scheduled ingestion error";
    await db
      .update(ingestionRunsTable)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: errorMessage.slice(0, 2_000) })
      .where(eq(ingestionRunsTable.id, runId));
    logger.error({ err: error, runId }, "Scheduled PBS ingestion threw an uncaught error");
    return { status: "failed", runId, errorMessage, recoveredRunIds: acquisition.recoveredRunIds };
  }

  const [completedRun] = await db
    .select({
      status: ingestionRunsTable.status,
      errorMessage: ingestionRunsTable.errorMessage,
    })
    .from(ingestionRunsTable)
    .where(eq(ingestionRunsTable.id, runId))
    .limit(1);

  if (completedRun?.status !== "completed") {
    const errorMessage = completedRun?.errorMessage ?? "Scheduled ingestion did not complete";
    logger.error({ runId, status: completedRun?.status, errorMessage }, "Scheduled PBS ingestion failed");
    return { status: "failed", runId, errorMessage, recoveredRunIds: acquisition.recoveredRunIds };
  }

  logger.info({ runId }, "Scheduled PBS ingestion completed");
  return { status: "completed", runId, recoveredRunIds: acquisition.recoveredRunIds };
}