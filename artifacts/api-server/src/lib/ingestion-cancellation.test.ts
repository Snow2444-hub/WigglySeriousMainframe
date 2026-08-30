import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import {
  db,
  drugsTable,
  ingestionRunsTable,
  pbsItemsTable,
  pbsWatchlistTable,
  rawScheduleStagingTable,
  scheduleChangesTable,
} from "@workspace/db";
import { executeCurrentIngestionRun } from "./pbs-current-ingestion";
import {
  finalizeCancelledIngestionRun,
  IngestionCancelledError,
  isIngestionRunCancelRequested,
  requestIngestionRunCancellation,
  recoverInterruptedIngestionRuns,
} from "./ingestion-run-control";
import { fetchSchedule } from "./pbs-ingestion";
import { syncScheduleChangesFromStagedData } from "./schedule-changes";
import type { FetchedSchedulePage, FetchedSchedulePayload } from "./pbs-ingestion";

let fixtureNumber = 0;

function token(): string {
  fixtureNumber += 1;
  return `${process.pid}_${Date.now()}_${fixtureNumber}`;
}

async function createRun(status: "queued" | "running" | "completed" | "cancelled"): Promise<number> {
  const [run] = await db
    .insert(ingestionRunsTable)
    .values({ status, mode: "current", scheduleDate: "2026-08-30" })
    .returning({ id: ingestionRunsTable.id });
  if (!run) throw new Error("Could not create cancellation fixture run");
  return run.id;
}

test("cancels cooperatively between pages and deletes run-scoped staging", async () => {
  const runId = await createRun("running");
  const scheduleCode = 2_300_000_000 + fixtureNumber;
  let pageCount = 0;
  try {
    await assert.rejects(
      fetchSchedule({
        scheduleDate: "2026-08-30",
        endpoints: ["items"],
        limit: 1,
        stagingRunId: runId,
        filters: [{ requestKey: `items-snapshot:schedule-${scheduleCode}`, params: {} }],
        request: async (input) => {
          const page = new URL(input).searchParams.get("page");
          const payload =
            page === "1"
              ? {
                  data: [{ li_item_id: "cancel-between-pages" }],
                  _links: [{ rel: "next", href: "https://data-api.health.gov.au/pbs/api/v3/items?page=2&limit=1" }],
                }
              : { data: [{ li_item_id: "should-not-be-fetched" }] };
          return new Response(JSON.stringify(payload), { status: 200 });
        },
        sleep: async () => {},
        shouldCancel: () => isIngestionRunCancelRequested(runId),
        onPage: async () => {
          pageCount += 1;
          if (pageCount === 1) await requestIngestionRunCancellation(runId);
        },
      }),
      (error) => error instanceof IngestionCancelledError,
    );

    await finalizeCancelledIngestionRun(runId);
    const [run] = await db
      .select({ status: ingestionRunsTable.status })
      .from(ingestionRunsTable)
      .where(eq(ingestionRunsTable.id, runId));
    const staged = await db
      .select({ id: rawScheduleStagingTable.id })
      .from(rawScheduleStagingTable)
      .where(likeRun(runId));
    assert.equal(pageCount, 1);
    assert.equal(run?.status, "cancelled");
    assert.equal(staged.length, 0);
  } finally {
    await db.delete(rawScheduleStagingTable).where(likeRun(runId));
    await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, runId));
  }
});

test("cancellation requested during a fetch stops before schedule-change detection", async () => {
  const runId = await createRun("queued");
  const watchlistValue = `cancellation-fixture-${token()}`;
  let fetchCalls = 0;
  let changeDetectionCalls = 0;
  let publishedFileCalls = 0;
  try {
    const [watchlist] = await db
      .insert(pbsWatchlistTable)
      .values({ filterType: "drug_name", filterValue: watchlistValue, enabled: true })
      .returning({ id: pbsWatchlistTable.id });
    assert.ok(watchlist);

    await executeCurrentIngestionRun(runId, "2026-08-30", undefined, {
      fetchSchedule: async (options) => {
        fetchCalls += 1;
        const page: FetchedSchedulePage = {
          endpoint: "schedules",
          requestKey: `schedule-metadata:${runId}`,
          pageNumber: 1,
          records: 1,
          url: "https://pbs.test/schedules",
        };
        const payload: FetchedSchedulePayload = {
          ...page,
          payload: { data: [{ schedule_code: 2_300_000_001, effective_date: "2026-08-01" }] },
        };
        await options.onPage?.(page);
        await options.onPayload?.(payload);
        await requestIngestionRunCancellation(runId);
        return [page];
      },
      syncScheduleChangesFromStagedData: async () => {
        changeDetectionCalls += 1;
        return 0;
      },
      ingestPublishedFiles: async () => {
        publishedFileCalls += 1;
        return { fetchedAt: new Date().toISOString(), files: [] };
      },
    });

    const [run] = await db
      .select({ status: ingestionRunsTable.status })
      .from(ingestionRunsTable)
      .where(eq(ingestionRunsTable.id, runId));
    assert.equal(fetchCalls, 1);
    assert.equal(changeDetectionCalls, 0);
    assert.equal(publishedFileCalls, 0);
    assert.equal(run?.status, "cancelled");
  } finally {
    await db.delete(pbsWatchlistTable).where(eq(pbsWatchlistTable.filterValue, watchlistValue));
    await db.delete(rawScheduleStagingTable).where(likeRun(runId));
    await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, runId));
  }
});

test("cancelled runs are not auto-resumed after restart recovery", async () => {
  const runId = await createRun("queued");
  try {
    const result = await requestIngestionRunCancellation(runId);
    assert.equal(result?.kind, "cancelled");
    assert.deepEqual(await recoverInterruptedIngestionRuns([runId]), []);
    const [run] = await db
      .select({ status: ingestionRunsTable.status })
      .from(ingestionRunsTable)
      .where(eq(ingestionRunsTable.id, runId));
    assert.equal(run?.status, "cancelled");
  } finally {
    await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, runId));
  }
});

test("late completion cannot overwrite a cancellation request", async () => {
  const runId = await createRun("running");
  try {
    const result = await requestIngestionRunCancellation(runId);
    assert.equal(result?.kind, "requested");
    const lateCompletion = await db
      .update(ingestionRunsTable)
      .set({ status: "completed", finishedAt: new Date() })
      .where(
        and(
          eq(ingestionRunsTable.id, runId),
          eq(ingestionRunsTable.status, "running"),
          isNull(ingestionRunsTable.cancelRequestedAt),
        ),
      )
      .returning({ id: ingestionRunsTable.id });
    assert.equal(lateCompletion.length, 0);
    await finalizeCancelledIngestionRun(runId);
    const [run] = await db
      .select({ status: ingestionRunsTable.status })
      .from(ingestionRunsTable)
      .where(eq(ingestionRunsTable.id, runId));
    assert.equal(run?.status, "cancelled");
  } finally {
    await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, runId));
  }
});

test("cancelled staged snapshots cannot become authoritative or drive delisting detection", async () => {
  const fixture = token();
  const previousScheduleCode = 1_800_000_000 + fixtureNumber;
  const cancelledScheduleCode = previousScheduleCode + 1;
  const drugId = 1_900_000_000 + fixtureNumber;
  const previousRunId = await createRun("completed");
  const cancelledRunId = await createRun("cancelled");
  const scheduleDate = `2099-${String((fixtureNumber % 9) + 1).padStart(2, "0")}-01`;
  const itemPayload = {
    data: [{
      li_item_id: `cancelled-item-${fixture}`,
      pbs_code: `CANCEL-${fixture}`,
      active_ingredient: `Cancellation ingredient ${fixture}`,
      brand_name: "Cancellation brand",
      strength: "10 mg",
      determined_price: 10,
      formulary: "F1",
    }],
  };
  try {
    await db.insert(drugsTable).values({
      id: drugId,
      name: `Cancellation ingredient ${fixture}`,
      activeIngredient: `Cancellation ingredient ${fixture}`,
      sponsor: "Cancellation fixture",
      firstPbsListingDate: "2020-01-01",
    });
    await db.insert(pbsItemsTable).values({
      itemCode: `cancelled-item-${fixture}`,
      pbsCode: `CANCEL-${fixture}`,
      liItemId: `cancelled-item-${fixture}`,
      scheduleCode: previousScheduleCode,
      drugId,
      brandName: "Cancellation brand",
      strength: "10 mg",
      formulary: "F1",
      currentAemp: 10,
      lastUpdated: "2026-08-01",
    });
    await db.insert(rawScheduleStagingTable).values([
      {
        scheduleDate,
        endpoint: "schedules",
        requestKey: `schedule-metadata:${previousScheduleCode}`,
        pageNumber: 1,
        payload: { data: [{ schedule_code: previousScheduleCode, effective_date: "2026-07-01" }] },
      },
      {
        scheduleDate,
        endpoint: "schedules",
        requestKey: `schedule-metadata:${cancelledScheduleCode}`,
        pageNumber: 1,
        payload: { data: [{ schedule_code: cancelledScheduleCode, effective_date: "2026-08-01" }] },
      },
      {
        scheduleDate,
        endpoint: "items",
        requestKey: `items-snapshot:schedule-${previousScheduleCode}:run-${previousRunId}`,
        pageNumber: 1,
        coverageScope: "schedule",
        coverageComplete: true,
        payload: itemPayload,
      },
      {
        scheduleDate,
        endpoint: "items",
        requestKey: `items-snapshot:schedule-${cancelledScheduleCode}:run-${cancelledRunId}`,
        pageNumber: 1,
        coverageScope: "schedule",
        coverageComplete: true,
        payload: { data: [] },
      },
    ]);

    assert.equal(
      await syncScheduleChangesFromStagedData({ scheduleCodes: [previousScheduleCode, cancelledScheduleCode] }),
      0,
    );
    const changes = await db
      .select({ id: scheduleChangesTable.id })
      .from(scheduleChangesTable)
      .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, cancelledScheduleCode]));
    assert.equal(changes.length, 0);
  } finally {
    await db
      .delete(scheduleChangesTable)
      .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, cancelledScheduleCode]));
    await db.delete(rawScheduleStagingTable).where(eq(rawScheduleStagingTable.scheduleDate, scheduleDate));
    await db.delete(pbsItemsTable).where(eq(pbsItemsTable.itemCode, `cancelled-item-${fixture}`));
    await db.delete(drugsTable).where(eq(drugsTable.id, drugId));
    await db.delete(ingestionRunsTable).where(inArray(ingestionRunsTable.id, [previousRunId, cancelledRunId]));
  }
});

function likeRun(runId: number) {
  return like(rawScheduleStagingTable.requestKey, `%:run-${runId}`);
}