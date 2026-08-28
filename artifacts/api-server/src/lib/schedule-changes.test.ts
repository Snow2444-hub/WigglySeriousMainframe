import assert from "node:assert/strict";
import test from "node:test";
import { asc, eq, inArray } from "drizzle-orm";
import {
  db,
  drugsTable,
  pbsItemsTable,
  rawScheduleStagingTable,
  scheduleChangesTable,
} from "@workspace/db";
import { fetchSchedule } from "./pbs-ingestion";
import {
  compareScheduleSnapshots,
  syncScheduleChangesFromStagedData,
  type PriceChangeThresholds,
  type ScheduleSnapshot,
  type SnapshotItem,
} from "./schedule-changes";

const thresholds: PriceChangeThresholds = {
  mediumReductionPercentage: 10,
  highReductionPercentage: 20,
  firstNewBrandHighSignificance: true,
  firstNewBrandReductionPercentage: 25,
};

function item(
  overrides: Partial<SnapshotItem> = {},
): SnapshotItem {
  return {
    liItemId: "item-1",
    pbsCode: "1000A",
    drugKey: "example",
    brandName: "Example",
    strength: "10 mg",
    determinedPrice: 10,
    formulary: "F1",
    listingFields: {
      benefit_type: "U",
      maximum_quantity: 30,
      maximum_prescribable_packs: 1,
      number_of_repeats: 5,
      pack_size: 30,
      restriction_indicators: { note_indicator: "N" },
      caution_indicators: { caution_indicator: "N" },
    },
    premiumRules: [],
    ...overrides,
  };
}

function snapshot(
  drugs: Map<string, Map<string, SnapshotItem>>,
  scheduleCode: number,
  effectiveDate: string,
): ScheduleSnapshot {
  return { scheduleCode, effectiveDate, drugs };
}

test("detects all dispensing-relevant listing amendments in one record", () => {
  const previousItem = item();
  const currentItem = item({
    listingFields: {
      benefit_type: "A",
      maximum_quantity: 60,
      maximum_prescribable_packs: 2,
      number_of_repeats: 1,
      pack_size: 60,
      restriction_indicators: { note_indicator: "Y" },
      caution_indicators: { caution_indicator: "Y" },
    },
  });
  const changes = compareScheduleSnapshots(
    snapshot(new Map([["example", new Map([[previousItem.liItemId, previousItem]])]]), 1, "2026-01-01"),
    snapshot(new Map([["example", new Map([[currentItem.liItemId, currentItem]])]]), 2, "2026-02-01"),
    new Map([["example", 42]]),
    thresholds,
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, "listing_amendment");
  assert.deepEqual((changes[0].newValue as { changed_fields: string[] }).changed_fields, [
    "benefit_type",
    "maximum_quantity",
    "maximum_prescribable_packs",
    "number_of_repeats",
    "pack_size",
    "restriction_indicators",
    "caution_indicators",
  ]);
  assert.match(changes[0].notes ?? "", /benefit type changed from unrestricted to authority/);
  assert.match(changes[0].notes ?? "", /maximum prescribable packs changed from 1 to 2/);
  assert.match(changes[0].notes ?? "", /caution indicators changed/);
});

test("detects a delisted item when its entire drug disappears from the next schedule", () => {
  const previousItem = item();
  const changes = compareScheduleSnapshots(
    snapshot(new Map([["example", new Map([[previousItem.liItemId, previousItem]])]]), 1, "2026-01-01"),
    snapshot(new Map(), 2, "2026-02-01"),
    new Map([["example", 42]]),
    thresholds,
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, "delisted");
  assert.equal(changes[0].liItemId, previousItem.liItemId);
  assert.equal(changes[0].newValue, null);
});

test("detects a delisted item when the drug remains but the item disappears", () => {
  const previousItem = item();
  const remainingItem = item({ liItemId: "item-2", pbsCode: "1000B" });
  const changes = compareScheduleSnapshots(
    snapshot(new Map([["example", new Map([[previousItem.liItemId, previousItem]])]]), 1, "2026-01-01"),
    snapshot(new Map([["example", new Map([[remainingItem.liItemId, remainingItem]])]]), 2, "2026-02-01"),
    new Map([["example", 42]]),
    thresholds,
  );

  const delisted = changes.find((change) => change.changeType === "delisted");
  assert.ok(delisted);
  assert.equal(delisted.liItemId, previousItem.liItemId);
});

type SnapshotCoverage = "complete" | "filtered" | "capped";

const fixtureItems = [
  {
    li_item_id: "task-32-removed",
    pbs_code: "T32-REMOVED",
    active_ingredient: "Task 32 fixture ingredient",
    brand_name: "Task 32 brand",
    strength: "10 mg",
    determined_price: 10,
    formulary: "F1",
  },
  {
    li_item_id: "task-32-retained",
    pbs_code: "T32-RETAINED",
    active_ingredient: "Task 32 fixture ingredient",
    brand_name: "Task 32 brand",
    strength: "20 mg",
    determined_price: 20,
    formulary: "F1",
  },
];

async function stageFixtureSchedule(input: {
  scheduleCode: number;
  effectiveDate: string;
  scheduleDate: string;
  items: typeof fixtureItems;
  coverage: SnapshotCoverage;
  stagingRunId?: number;
  interrupted?: boolean;
}): Promise<void> {
  const request = async (requestUrl: string | URL): Promise<Response> => {
    const url = new URL(requestUrl);
    const isScheduleMetadata = url.pathname.endsWith("/schedules");
    const payload = isScheduleMetadata
      ? {
          data: [
            {
              schedule_code: input.scheduleCode,
              effective_date: input.effectiveDate,
            },
          ],
        }
      : {
          data: input.items,
          ...(input.coverage === "capped"
            ? { _links: [{ rel: "next", href: "/api/v3/items?page=2&limit=1" }] }
            : {}),
        };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await fetchSchedule({
    scheduleDate: input.scheduleDate,
    endpoints: ["schedules"],
    limit: 100,
    filters: [{ requestKey: `schedule-metadata:${input.scheduleCode}`, params: {} }],
    request,
    sleep: async () => {},
  });
  await fetchSchedule({
    scheduleDate: input.scheduleDate,
    endpoints: ["items"],
    ...(input.coverage === "capped" ? { maxPages: 1 } : {}),
    filters: [{ requestKey: `items-snapshot:schedule-${input.scheduleCode}`, params: {} }],
    coverageScope: input.coverage === "filtered" ? "filtered" : "schedule",
    stagingRunId: input.stagingRunId,
    onPayload: async (page) => {
      if (input.interrupted && page.endpoint === "items") {
        throw new Error("fixture interruption after staging");
      }
    },
    request,
    sleep: async () => {},
  });
}

test("only complete unfiltered staged snapshots produce delisted events", async () => {
  const scenarios: Array<{ coverage: SnapshotCoverage; expectedChanges: number }> = [
    { coverage: "complete", expectedChanges: 1 },
    { coverage: "filtered", expectedChanges: 0 },
    { coverage: "capped", expectedChanges: 0 },
  ];
  const fixtureBase = 1_600_000_000 + ((Date.now() + process.pid) % 100_000) * 10;

  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const previousScheduleCode = fixtureBase + scenarioIndex * 2;
    const currentScheduleCode = previousScheduleCode + 1;
    const drugId = fixtureBase + scenarioIndex;
    const scheduleDate = `2090-0${scenarioIndex + 1}-01`;
    const effectiveDates = [`2091-0${scenarioIndex + 1}-01`, `2091-0${scenarioIndex + 1}-02`];

    try {
      await db.insert(drugsTable).values({
        id: drugId,
        name: "Task 32 fixture drug",
        activeIngredient: "Task 32 fixture ingredient",
        sponsor: "Task 32 fixture",
        firstPbsListingDate: "2090-01-01",
      });
      await stageFixtureSchedule({
        scheduleCode: previousScheduleCode,
        effectiveDate: effectiveDates[0],
        scheduleDate,
        items: fixtureItems,
        coverage: "complete",
      });
      await stageFixtureSchedule({
        scheduleCode: currentScheduleCode,
        effectiveDate: effectiveDates[1],
        scheduleDate,
        items: [fixtureItems[1]],
        coverage: scenario.coverage,
      });

      await syncScheduleChangesFromStagedData();
      const changes = await db
        .select({
          changeType: scheduleChangesTable.changeType,
          liItemId: scheduleChangesTable.liItemId,
        })
        .from(scheduleChangesTable)
        .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, currentScheduleCode]));

      assert.equal(
        changes.filter((change) => change.changeType === "delisted").length,
        scenario.expectedChanges,
        `${scenario.coverage} fixture should produce the expected delisted event count`,
      );
      if (scenario.coverage === "complete") {
        assert.deepEqual(
          changes.filter((change) => change.changeType === "delisted").map((change) => change.liItemId),
          ["task-32-removed"],
        );
      }
    } finally {
      await db
        .delete(scheduleChangesTable)
        .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, currentScheduleCode]));
      await db
        .delete(rawScheduleStagingTable)
        .where(inArray(rawScheduleStagingTable.scheduleDate, [scheduleDate]));
      await db.delete(pbsItemsTable).where(eq(pbsItemsTable.drugId, drugId));
      await db.delete(drugsTable).where(eq(drugsTable.id, drugId));
    }
  }
});

test("interrupted schedule-wide staging stays incomplete when a later run uses the same schedule", async () => {
  const previousScheduleCode = 1_950_000_001 + ((Date.now() + process.pid) % 100_000) * 2;
  const currentScheduleCode = previousScheduleCode + 1;
  const drugId = previousScheduleCode;
  const scheduleDate = "2092-01-01";
  const effectiveDates = ["2092-01-01", "2092-02-01"];
  const interruptedRunId = previousScheduleCode + 10;
  const laterRunId = interruptedRunId + 1;

  try {
    await db.insert(drugsTable).values({
      id: drugId,
      name: "Task 33 fixture drug",
      activeIngredient: "Task 32 fixture ingredient",
      sponsor: "Task 33 fixture",
      firstPbsListingDate: "2090-01-01",
    });
    await stageFixtureSchedule({
      scheduleCode: previousScheduleCode,
      effectiveDate: effectiveDates[0],
      scheduleDate,
      items: fixtureItems,
      coverage: "complete",
      stagingRunId: interruptedRunId,
    });
    await assert.rejects(
      stageFixtureSchedule({
        scheduleCode: currentScheduleCode,
        effectiveDate: effectiveDates[1],
        scheduleDate,
        items: [fixtureItems[1]],
        coverage: "capped",
        stagingRunId: interruptedRunId,
        interrupted: true,
      }),
      /fixture interruption after staging/,
    );
    await stageFixtureSchedule({
      scheduleCode: currentScheduleCode,
      effectiveDate: effectiveDates[1],
      scheduleDate,
      items: [fixtureItems[1]],
      coverage: "capped",
      stagingRunId: laterRunId,
    });

    const stagedRows = await db
      .select({
        requestKey: rawScheduleStagingTable.requestKey,
        coverageComplete: rawScheduleStagingTable.coverageComplete,
      })
      .from(rawScheduleStagingTable)
      .where(eq(rawScheduleStagingTable.scheduleDate, scheduleDate))
      .orderBy(asc(rawScheduleStagingTable.id));
    const currentRows = stagedRows.filter((row) =>
      row.requestKey.includes(`schedule-${currentScheduleCode}`),
    );

    assert.deepEqual(
      currentRows,
      [
        {
          requestKey: `items-snapshot:schedule-${currentScheduleCode}:run-${interruptedRunId}`,
          coverageComplete: false,
        },
        {
          requestKey: `items-snapshot:schedule-${currentScheduleCode}:run-${laterRunId}`,
          coverageComplete: false,
        },
      ],
    );
    assert.equal(await syncScheduleChangesFromStagedData(), 0);
    const changes = await db
      .select({ changeType: scheduleChangesTable.changeType })
      .from(scheduleChangesTable)
      .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, currentScheduleCode]));
    assert.equal(changes.filter((change) => change.changeType === "delisted").length, 0);
  } finally {
    await db
      .delete(scheduleChangesTable)
      .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, currentScheduleCode]));
    await db.delete(rawScheduleStagingTable).where(eq(rawScheduleStagingTable.scheduleDate, scheduleDate));
    await db.delete(pbsItemsTable).where(eq(pbsItemsTable.drugId, drugId));
    await db.delete(drugsTable).where(eq(drugsTable.id, drugId));
  }
});