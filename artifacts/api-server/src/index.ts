import app from "./app";
import { logger } from "./lib/logger";
import { seedReferenceData } from "./lib/seed";
import { ensureDefaultReductionSettings } from "./lib/predicted-reductions";
import {
  ensureDefaultScheduleChangeSettings,
  recalculatePriceChangeSignificance,
} from "./lib/schedule-changes";
import { recoverInterruptedIngestionRuns } from "./routes/admin";

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
  await recoverInterruptedIngestionRuns();
  await ensureDefaultReductionSettings();
  await ensureDefaultScheduleChangeSettings();
  await recalculatePriceChangeSignificance();
  if (process.env.SEED_REFERENCE_DATA === "true") {
    await seedReferenceData();
  }
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

start().catch((err) => {
  logger.error({ err }, "Failed to start API server");
  process.exit(1);
});
