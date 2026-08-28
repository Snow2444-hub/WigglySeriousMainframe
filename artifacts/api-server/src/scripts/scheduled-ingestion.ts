import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { runScheduledIngestion } from "../lib/scheduled-ingestion";

async function main(): Promise<void> {
  const result = await runScheduledIngestion();
  if (result.status === "skipped") {
    logger.info({ activeRunId: result.activeRunId }, "Scheduled PBS ingestion made no changes");
    return;
  }
  if (result.status === "failed") {
    throw new Error(`Scheduled PBS ingestion failed for run ${result.runId}: ${result.errorMessage}`);
  }
  logger.info({ runId: result.runId }, "Scheduled PBS ingestion job finished successfully");
}

main()
  .catch((error) => {
    logger.error({ err: error }, "Scheduled PBS ingestion job failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });