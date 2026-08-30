import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baselinePath = path.resolve(process.cwd(), "../../docs/authority-baseline.json");
const postPath = path.resolve(process.cwd(), "../../docs/authority-post-backfill.json");
const reportPath = path.resolve(process.cwd(), "../../docs/authority-backfill-diff.json");

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const post = JSON.parse(await readFile(postPath, "utf8"));

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

for (const tableName of ["pbsItems", "predictedReductions", "scheduleChanges"]) {
  assert.deepEqual(
    post.inventory[tableName].stableIds,
    baseline.inventory[tableName].stableIds,
    `${tableName} stable IDs changed`,
  );
}

const hiddenDrugIds = difference(
  baseline.inventory.drugs.stableIds,
  post.inventory.drugs.stableIds,
);
const addedDrugIds = difference(
  post.inventory.drugs.stableIds,
  baseline.inventory.drugs.stableIds,
);
assert.equal(hiddenDrugIds.length, 103, "Expected exactly 103 classified test drugs to become hidden");
assert.deepEqual(addedDrugIds, [], "Backfill unexpectedly added visible drugs");

const hiddenRunIds = difference(
  baseline.inventory.ingestionRuns.stableIds,
  post.inventory.ingestionRuns.stableIds,
);
const addedRunIds = difference(
  post.inventory.ingestionRuns.stableIds,
  baseline.inventory.ingestionRuns.stableIds,
);
assert.deepEqual(hiddenRunIds, [749, 750], "Only the two classified test runs may become hidden");
assert.deepEqual(addedRunIds, [-1], "Only the explicit legacy authority root may be added");

for (const [tableName, inventory] of Object.entries(post.inventory)) {
  assert.equal(inventory.nullAuthorityCount, 0, `${tableName} retained visible NULL authority`);
  assert.equal(
    inventory.nonNullAuthorityCount,
    inventory.rowCount,
    `${tableName} visible authority coverage is incomplete`,
  );
}

assert.deepEqual(
  post.endpointResponses,
  baseline.endpointResponses,
  "Representative endpoint responses changed after the authority backfill",
);
assert.deepEqual(
  post.derivedResults,
  baseline.derivedResults,
  "Prediction or schedule-change distributions changed after the authority backfill",
);
assert.equal(
  post.ingestionState.activeRunCount,
  baseline.ingestionState.activeRunCount,
  "Active-run behavior changed after the authority backfill",
);
const userVisibleCurrentScheduleRun = (run) => {
  if (!run) return null;
  const { authority_scope: _authorityScope, ...visibleFields } = run;
  return visibleFields;
};
assert.deepEqual(
  userVisibleCurrentScheduleRun(post.ingestionState.dashboardCurrentScheduleRun),
  userVisibleCurrentScheduleRun(baseline.ingestionState.dashboardCurrentScheduleRun),
  "Dashboard current-schedule selection changed after the authority backfill",
);

const report = {
  passed: true,
  comparedAt: new Date().toISOString(),
  source: {
    baseline: path.relative(path.resolve(process.cwd(), "../.."), baselinePath),
    postBackfill: path.relative(path.resolve(process.cwd(), "../.."), postPath),
    schema: post.source.schema,
    currentUser: post.source.currentUser,
    sessionUser: post.source.sessionUser,
  },
  expectedVisibilityChanges: {
    hiddenKnownTestDrugCount: hiddenDrugIds.length,
    hiddenKnownTestDrugIds: hiddenDrugIds,
    hiddenKnownTestRunIds: hiddenRunIds,
    addedMigrationAuthorityRunIds: addedRunIds,
  },
  preserved: {
    visibleDrugCount: post.inventory.drugs.rowCount,
    pbsItemCount: post.inventory.pbsItems.rowCount,
    predictionCount: post.inventory.predictedReductions.rowCount,
    scheduleChangeCount: post.inventory.scheduleChanges.rowCount,
    visibleIngestionRunCount: post.inventory.ingestionRuns.rowCount,
    representativeEndpointResponseCount: post.endpointResponses.length,
    predictionDistribution: true,
    scheduleChangeDistribution: true,
    activeRunBehavior: true,
    dashboardCurrentScheduleRun: true,
  },
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Authority backfill baseline diff passed; report written to ${reportPath}`);