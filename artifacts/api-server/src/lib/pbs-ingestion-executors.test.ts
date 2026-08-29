import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  db,
  drugsTable,
  ingestionRunsTable,
  pbsItemPremiumHistoryTable,
  pbsItemsTable,
  pbsWatchlistTable,
  pool,
  predictedReductionsTable,
  priceHistoryTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  executeBackfillIngestionRun,
} from "../routes/admin";
import { executeCurrentIngestionRun } from "./pbs-current-ingestion";
import type {
  FetchScheduleOptions,
  FetchedSchedulePage,
  FetchedSchedulePayload,
} from "./pbs-ingestion";
import type { PbsIngestionExecutorDependencies } from "./pbs-ingestion-executor-dependencies";

let fixtureNumber = 0;

function fixtureToken(): string {
  fixtureNumber += 1;
  return `executor_${process.pid}_${fixtureNumber}`;
}

function itemPayload(itemCode: string, ingredient: string, scheduleCode: number, brandName: string) {
  return {
    data: [
      {
        li_item_id: itemCode,
        pbs_code: `PBS-${itemCode}`,
        active_ingredient: ingredient,
        drug_name: ingredient,
        brand_name: brandName,
        formulary: "F2",
        schedule_code: scheduleCode,
        determined_price: 100,
        dispensed_price: 2,
        first_listed_date: "2020-01-01",
        li_form: "Tablet 10 mg",
      },
      {
        li_item_id: `${itemCode}_OTHER`,
        pbs_code: `PBS-${itemCode}_OTHER`,
        active_ingredient: `${ingredient} unrelated`,
        drug_name: `${ingredient} unrelated`,
        brand_name: `${brandName} unrelated`,
        formulary: "F2",
        schedule_code: scheduleCode,
        determined_price: 100,
        first_listed_date: "2020-01-01",
        li_form: "Tablet 10 mg",
      },
    ],
  };
}

function premiumPayload(itemCode: string, unrelatedItemCode: string) {
  return {
    data: [
      {
        li_item_id: itemCode,
        dispensing_rule_reference: "R1",
        dispensing_rule_mnem: "STD",
        brand_premium: 1.25,
        therapeutic_group_premium: 0.5,
      },
      {
        li_item_id: unrelatedItemCode,
        dispensing_rule_reference: "R2",
        dispensing_rule_mnem: "OTHER",
        brand_premium: 99,
        therapeutic_group_premium: 99,
      },
    ],
  };
}

function scheduleMetadataPayload(schedules: Array<{ schedule_code: number; effective_date: string }>) {
  return { data: schedules };
}

function fakeFetcher(
  calls: FetchScheduleOptions[],
  input: {
    itemCode: string;
    ingredient: string;
    brandName: string;
    schedules: Array<{ schedule_code: number; effective_date: string }>;
    includeAtc: boolean;
  },
): NonNullable<PbsIngestionExecutorDependencies["fetchSchedule"]> {
  return async (options) => {
    calls.push(options);
    const filter = options.filters?.[0];
    const endpoint = filter?.endpoint ?? options.endpoints?.[0] ?? "items";
    let payload: unknown;

    if (endpoint === "schedules") {
      payload = scheduleMetadataPayload(input.schedules);
    } else if (endpoint === "item-atc-relationships") {
      payload = { data: [{ li_item_id: input.itemCode }] };
    } else if (endpoint === "items") {
      const scheduleCode = Number(filter?.params.schedule_code ?? input.schedules.at(-1)?.schedule_code);
      payload = itemPayload(input.itemCode, input.ingredient, scheduleCode, input.brandName);
    } else if (endpoint === "item-dispensing-rule-relationships") {
      payload = premiumPayload(input.itemCode, `${input.itemCode}_OTHER`);
    } else {
      throw new Error(`Unexpected fake PBS endpoint: ${endpoint}`);
    }

    const page: FetchedSchedulePage = {
      endpoint,
      requestKey: filter?.requestKey ?? "unfiltered",
      pageNumber: 1,
      records: Array.isArray((payload as { data?: unknown }).data)
        ? ((payload as { data: unknown[] }).data.length)
        : 0,
      url: `https://pbs.test/${endpoint}?request=${calls.length}`,
    };
    await options.onPage?.(page);
    await options.onPayload?.({ ...page, payload } as FetchedSchedulePayload);
    return [page];
  };
}

async function createRun(mode: "current" | "backfill", scheduleDate: string): Promise<number> {
  const [run] = await db
    .insert(ingestionRunsTable)
    .values({ status: "queued", mode, scheduleDate })
    .returning({ id: ingestionRunsTable.id });
  if (!run) throw new Error("Could not create PBS executor test run");
  return run.id;
}

async function cleanupFixture(input: {
  runId: number;
  watchlistIds: number[];
  itemCode: string;
  ingredient: string;
}) {
  const [drug] = await db
    .select({ id: drugsTable.id })
    .from(drugsTable)
    .where(eq(drugsTable.activeIngredient, input.ingredient))
    .limit(1);

  await db.delete(pbsItemPremiumHistoryTable).where(eq(pbsItemPremiumHistoryTable.itemCode, input.itemCode));
  await db.delete(predictedReductionsTable).where(drug ? eq(predictedReductionsTable.drugId, drug.id) : eq(predictedReductionsTable.drugId, -1));
  await db.delete(priceHistoryTable).where(eq(priceHistoryTable.itemCode, input.itemCode));
  await db.delete(pbsItemsTable).where(eq(pbsItemsTable.itemCode, input.itemCode));
  if (drug) await db.delete(drugsTable).where(eq(drugsTable.id, drug.id));
  await db.delete(pbsWatchlistTable).where(inArray(pbsWatchlistTable.id, input.watchlistIds));
  await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, input.runId));
}

async function withOnlyFixtureWatchlist<T>(
  entries: Array<{ filterType: "brand_name" | "drug_name" | "pbs_code" | "formulary" | "program_code" | "atc_code"; filterValue: string }>,
  callback: (watchlistIds: number[]) => Promise<T>,
): Promise<T> {
  const existingEnabled = await db
    .select({ id: pbsWatchlistTable.id })
    .from(pbsWatchlistTable)
    .where(eq(pbsWatchlistTable.enabled, true));
  if (existingEnabled.length > 0) {
    await db
      .update(pbsWatchlistTable)
      .set({ enabled: false })
      .where(inArray(pbsWatchlistTable.id, existingEnabled.map((entry) => entry.id)));
  }

  const inserted = await db
    .insert(pbsWatchlistTable)
    .values(entries.map((entry) => ({ ...entry, enabled: true })))
    .returning({ id: pbsWatchlistTable.id });
  const watchlistIds = inserted.map((entry) => entry.id);

  try {
    return await callback(watchlistIds);
  } finally {
    await db.delete(pbsWatchlistTable).where(inArray(pbsWatchlistTable.id, watchlistIds));
    if (existingEnabled.length > 0) {
      await db
        .update(pbsWatchlistTable)
        .set({ enabled: true })
        .where(inArray(pbsWatchlistTable.id, existingEnabled.map((entry) => entry.id)));
    }
  }
}

test("current executor fetches one ATC lookup and two full snapshots with local filtering", async () => {
  const token = fixtureToken();
  const itemCode = `${token}_ITEM`;
  const ingredient = `${token} ingredient`;
  const brandName = `${token} target brand`;
  const scheduleCode = 910_001;
  const runId = await createRun("current", "2026-08-29");
  const calls: FetchScheduleOptions[] = [];
  let syncCalls = 0;
  let pruneCalls = 0;
  let publishedFileCalls = 0;

  try {
    await withOnlyFixtureWatchlist(
      [
        { filterType: "brand_name", filterValue: brandName },
        { filterType: "atc_code", filterValue: "N06BA" },
      ],
      async () => {
        await executeCurrentIngestionRun(runId, "2026-08-29", undefined, {
          fetchSchedule: fakeFetcher(calls, {
            itemCode,
            ingredient,
            brandName,
            schedules: [{ schedule_code: scheduleCode, effective_date: "2026-08-29" }],
            includeAtc: true,
          }),
          syncScheduleChangesFromStagedData: async () => {
            syncCalls += 1;
            return 0;
          },
          pruneRawScheduleStaging: async () => {
            pruneCalls += 1;
            return { deletedRows: 0 };
          },
          ingestPublishedFiles: async () => {
            publishedFileCalls += 1;
            return { fetchedAt: "2026-08-29T00:00:00.000Z", files: [] };
          },
        });
      },
    );

    assert.deepEqual(
      calls.map((call) => call.filters?.[0]?.endpoint ?? call.endpoints?.[0]),
      ["schedules", "item-atc-relationships", "items", "item-dispensing-rule-relationships"],
    );
    const itemCall = calls.find((call) => call.endpoints?.[0] === "items");
    const premiumCall = calls.find((call) => call.endpoints?.[0] === "item-dispensing-rule-relationships");
    const atcCall = calls.find((call) => call.filters?.[0]?.endpoint === "item-atc-relationships");
    assert.ok(itemCall);
    assert.ok(premiumCall);
    assert.ok(atcCall);
    assert.deepEqual(itemCall.filters?.[0]?.params, {});
    assert.deepEqual(premiumCall.filters?.[0]?.params, {});
    assert.deepEqual(atcCall.filters?.[0]?.params, { filter: "atc_code eq 'N06BA'" });
    assert.equal(itemCall.coverageScope, "schedule");
    assert.equal(premiumCall.coverageScope, "schedule");
    assert.equal(calls.some((call) => Object.keys(call.filters?.[0]?.params ?? {}).includes("li_item_id")), false);
    assert.equal(syncCalls, 1);
    assert.equal(pruneCalls, 1);
    assert.equal(publishedFileCalls, 1);

    const [run] = await db
      .select({
        status: ingestionRunsTable.status,
        recordsProcessed: ingestionRunsTable.recordsProcessed,
        snapshotComplete: ingestionRunsTable.snapshotComplete,
      })
      .from(ingestionRunsTable)
      .where(eq(ingestionRunsTable.id, runId));
    assert.deepEqual(run, { status: "completed", recordsProcessed: 2, snapshotComplete: true });

    const [premium] = await db
      .select({ itemCode: pbsItemPremiumHistoryTable.itemCode })
      .from(pbsItemPremiumHistoryTable)
      .where(eq(pbsItemPremiumHistoryTable.itemCode, itemCode));
    assert.deepEqual(premium, { itemCode });
  } finally {
    await cleanupFixture({ runId, watchlistIds: [], itemCode, ingredient });
  }
});

test("backfill uses schedule-scoped snapshots and request count is invariant to direct watchlist size", async () => {
  const schedules = [
    { schedule_code: 910_101, effective_date: "2025-09-01" },
    { schedule_code: 910_102, effective_date: "2026-08-01" },
  ];
  const runResults: Array<{ callCount: number; calls: FetchScheduleOptions[]; runId: number; itemCode: string; ingredient: string }> = [];

  for (const directEntryCount of [1, 4]) {
    const token = fixtureToken();
    const itemCode = `${token}_ITEM`;
    const ingredient = `${token} ingredient`;
    const brandName = `${token} target brand`;
    const runId = await createRun("backfill", "2026-08-29");
    const calls: FetchScheduleOptions[] = [];
    const directEntries = [
      { filterType: "brand_name" as const, filterValue: brandName },
      ...Array.from({ length: directEntryCount - 1 }, (_, index) => ({
        filterType: "brand_name" as const,
        filterValue: `${token} unmatched brand ${index}`,
      })),
    ];

    try {
      await withOnlyFixtureWatchlist(directEntries, async () => {
        await executeBackfillIngestionRun(runId, "2026-08-29", undefined, {
          fetchSchedule: fakeFetcher(calls, {
            itemCode,
            ingredient,
            brandName,
            schedules,
            includeAtc: false,
          }),
          syncScheduleChangesFromStagedData: async () => 0,
          pruneRawScheduleStaging: async () => ({ deletedRows: 0 }),
        });
      });
      runResults.push({ callCount: calls.length, calls, runId, itemCode, ingredient });
    } catch (error) {
      await cleanupFixture({ runId, watchlistIds: [], itemCode, ingredient });
      throw error;
    }
  }

  try {
    assert.equal(runResults[0]?.callCount, 5);
    assert.equal(runResults[1]?.callCount, runResults[0]?.callCount);
    for (const result of runResults) {
      const snapshotCalls = result.calls.filter((call) => call.coverageScope === "schedule");
      assert.equal(snapshotCalls.length, 4);
      assert.deepEqual(
        snapshotCalls.map((call) => call.filters?.[0]?.params.schedule_code).sort(),
        ["910101", "910101", "910102", "910102"],
      );
      assert.equal(
        snapshotCalls.some((call) => Object.keys(call.filters?.[0]?.params ?? {}).length !== 1),
        false,
      );
      assert.equal(
        snapshotCalls.some((call) => Object.keys(call.filters?.[0]?.params ?? {}).includes("li_item_id")),
        false,
      );

      const [run] = await db
        .select({
          status: ingestionRunsTable.status,
          schedulesProcessed: ingestionRunsTable.schedulesProcessed,
          snapshotComplete: ingestionRunsTable.snapshotComplete,
        })
        .from(ingestionRunsTable)
        .where(eq(ingestionRunsTable.id, result.runId));
      assert.deepEqual(run, { status: "completed", schedulesProcessed: 2, snapshotComplete: true });

      const items = await db
        .select({ itemCode: pbsItemsTable.itemCode })
        .from(pbsItemsTable)
        .where(eq(pbsItemsTable.itemCode, result.itemCode));
      const premiums = await db
        .select({ itemCode: pbsItemPremiumHistoryTable.itemCode })
        .from(pbsItemPremiumHistoryTable)
        .where(eq(pbsItemPremiumHistoryTable.itemCode, result.itemCode));
      assert.deepEqual(items, [{ itemCode: result.itemCode }]);
      assert.equal(premiums.length, 2);
    }
  } finally {
    for (const result of runResults) {
      await cleanupFixture({
        runId: result.runId,
        watchlistIds: [],
        itemCode: result.itemCode,
        ingredient: result.ingredient,
      });
    }
  }
});

after(async () => {
  await pool.end();
});