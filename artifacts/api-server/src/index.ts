import app from "./app";
import { logger } from "./lib/logger";
import { seedReferenceData } from "./lib/seed";
import { ensureDefaultReductionSettings } from "./lib/predicted-reductions";
import {
  ensureDefaultScheduleChangeSettings,
  recalculateNewBrandSignificance,
  recalculatePriceChangeSignificance,
} from "./lib/schedule-changes";
import { recoverInterruptedIngestionRuns } from "./lib/ingestion-run-control";
import { resumeIngestionRun } from "./lib/scheduled-ingestion";
import { executeIngestionRun } from "./routes/admin";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start(): Promise<void> {
  const interruptedRuns = await recoverInterruptedIngestionRuns();
  await ensureDefaultReductionSettings();
  await ensureDefaultScheduleChangeSettings();
  await recalculatePriceChangeSignificance();
  await recalculateNewBrandSignificance();
  if (process.env.SEED_REFERENCE_DATA === "true") {
    await seedReferenceData();
  }
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    if (interruptedRuns.length > 0) {
      setImmediate(() => {
        void (async () => {
          for (const run of interruptedRuns) {
            try {
              await resumeIngestionRun(run, executeIngestionRun);
            } catch (error) {
              logger.error({ err: error, runId: run.id }, "Failed to resume interrupted PBS ingestion run");
            }
          }
        })();
      });
    }
  });
}

start().catch((err) => {
  logger.error({ err }, "Failed to start API server");
  process.exit(1);
});
