import { writeFile } from "node:fs/promises";
import { pool } from "@workspace/db";
import {
  applyPbsDelistingDateBackfill,
  buildPbsDelistingDateBackfillReport,
} from "../lib/pbs-item-lifecycle";
import {
  completeProductionRepairRun,
  createProductionRepairRun,
  failProductionRepairRun,
} from "../lib/ingestion-run-control";

async function main(): Promise<void> {
  const report = await buildPbsDelistingDateBackfillReport();
  const reportPath = process.env.PBS_DELISTING_BACKFILL_REPORT_PATH ?? "pbs-delisting-date-backfill-report.json";
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    reportPath,
    delistedItemCount: report.delistedItemCount,
    matchedItemCount: report.matchedItemCount,
    unmatchedItemCount: report.unmatchedItemCount,
  }, null, 2));
  console.log(JSON.stringify(report.rows, null, 2));

  if (process.env.PBS_DELISTING_BACKFILL_CONFIRM !== "true") {
    console.log("Report only. Set PBS_DELISTING_BACKFILL_CONFIRM=true after reviewing the exported rows to apply.");
    return;
  }
  if (report.unmatchedItemCount > 0) {
    throw new Error("Refusing to apply a delisting date backfill with unmatched rows.");
  }

  const authorityRunId = await createProductionRepairRun(new Date().toISOString().slice(0, 10), 1);
  try {
    const appliedCount = await applyPbsDelistingDateBackfill(report);
    await completeProductionRepairRun(authorityRunId, 1);
    console.log(JSON.stringify({ authorityRunId, appliedCount }, null, 2));
  } catch (error) {
    await failProductionRepairRun(authorityRunId, error);
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());