import app from "./app";
import { inspectDatabaseAuthorityTarget } from "@workspace/db";
import { logger } from "./lib/logger";
import { seedReferenceData } from "./lib/seed";
import { ensureDefaultReductionSettings } from "./lib/predicted-reductions";
import {
  ensureDefaultScheduleChangeSettings,
  recalculateNewBrandSignificance,
  recalculatePriceChangeSignificance,
} from "./lib/schedule-changes";
import {
  recoverInterruptedIngestionRuns,
  recoverStaleIngestionRuns,
} from "./lib/ingestion-run-control";
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

const STARTUP_INITIALIZATION_RETRY_MS = 30_000;

async function logDatabaseAuthorityTarget(): Promise<void> {
  try {
    const target = await inspectDatabaseAuthorityTarget();
    logger.info({ databaseTarget: target }, "Database authority target inspected");
  } catch (error) {
    logger.error({ err: error }, "Database authority target inspection failed");
  }
}

async function initializeApplicationData(): Promise<void> {
  const interruptedRuns = await recoverInterruptedIngestionRuns();
  await ensureDefaultReductionSettings();
  await ensureDefaultScheduleChangeSettings();
  await recalculatePriceChangeSignificance();
  await recalculateNewBrandSignificance();
  if (process.env.SEED_REFERENCE_DATA === "true") {
    await seedReferenceData();
  }
  for (const run of interruptedRuns) {
    try {
      await resumeIngestionRun(run, executeIngestionRun);
    } catch (error) {
      logger.error({ err: error, runId: run.id }, "Failed to resume interrupted PBS ingestion run");
    }
  }
}

function runApplicationInitialization(): void {
  void initializeApplicationData()
    .then(() => {
      logger.info("Application data initialization completed");
    })
    .catch((error) => {
      logger.error({ err: error }, "Application data initialization failed; retrying");
      const retryTimer = setTimeout(
        runApplicationInitialization,
        STARTUP_INITIALIZATION_RETRY_MS,
      );
      retryTimer.unref();
    });
}

function start(): void {
  const server = app.listen(port, () => {
    logger.info({ port }, "Server listening");
    void logDatabaseAuthorityTarget();
    runApplicationInitialization();

    const staleRunWatchdog = setInterval(() => {
      void recoverStaleIngestionRuns().catch((error) => {
        logger.error({ err: error }, "Failed to check for stalled PBS ingestion runs");
      });
    }, 60_000);
    staleRunWatchdog.unref();
  });

  server.on("error", (error) => {
    logger.error({ err: error }, "Error listening on port");
    process.exitCode = 1;
  });
}

start();
