import { writeFile } from "node:fs/promises";
import { pool, PRODUCTION_AUTHORITY_SCOPE } from "@workspace/db";
import {
  createProductionRepairRun,
  completeProductionRepairRun,
  failProductionRepairRun,
} from "../lib/ingestion-run-control";
import {
  buildPbsCatalogueRepairReport,
  loadLatestCanonicalCurrentPbsSnapshot,
  reconcilePbsItemCatalogueStatus,
} from "../lib/pbs-item-lifecycle";
import { recalculatePredictedReductionsForDrug } from "../lib/predicted-reductions";

async function main(): Promise<void> {
  const snapshot = await loadLatestCanonicalCurrentPbsSnapshot();
  const report = await buildPbsCatalogueRepairReport(snapshot);
  const reportPath = process.env.PBS_CATALOGUE_REPAIR_REPORT_PATH ?? "pbs-catalogue-repair-report.json";
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    reportPath,
    sourceRunId: report.sourceRunId,
    scheduleCode: report.scheduleCode,
    effectiveDate: report.effectiveDate,
    snapshotItemCount: report.snapshotItemCount,
    proposedChangeCount: report.proposedChangeCount,
  }, null, 2));
  console.log(JSON.stringify(report.rows, null, 2));

  if (process.env.PBS_CATALOGUE_REPAIR_CONFIRM !== "true") {
    console.log("Report only. Set PBS_CATALOGUE_REPAIR_CONFIRM=true after reviewing the exported rows to apply.");
    return;
  }

  const authorityRunId = await createProductionRepairRun(report.effectiveDate, 1);
  try {
    const result = await reconcilePbsItemCatalogueStatus({
      authorityScope: PRODUCTION_AUTHORITY_SCOPE,
      scheduleCode: report.scheduleCode,
      effectiveDate: report.effectiveDate,
      snapshotItemCodes: snapshot.snapshotItemCodes,
    });
    await Promise.all(result.affectedDrugIds.map((drugId) =>
      recalculatePredictedReductionsForDrug(drugId, undefined, authorityRunId),
    ));
    await completeProductionRepairRun(authorityRunId, 1);
    console.log(JSON.stringify({
      authorityRunId,
      appliedChangeCount: result.delistedItemCodes.length + result.reactivatedItemCodes.length,
      delistedCount: result.delistedItemCodes.length,
      reactivatedCount: result.reactivatedItemCodes.length,
    }, null, 2));
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