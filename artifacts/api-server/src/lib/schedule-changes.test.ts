import assert from "node:assert/strict";
import test from "node:test";
import { asc, eq, inArray } from "drizzle-orm";
import {
  db,
  drugsTable,
  ingestionRunsTable,
  pbsItemsTable,
  rawScheduleStagingTable,
  runtimeAuthorityScope,
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
import { isAuthoritativeStagedSnapshot } from "./staged-snapshot-validity";

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

async function createFixtureIngestionRun(status: string): Promise<number> {
  const [run] = await db
    .insert(ingestionRunsTable)
    .values({
      status,
      mode: "current",
      scheduleDate: "2026-08-30",
      authorityScope: runtimeAuthorityScope(),
    })
    .returning({ id: ingestionRunsTable.id });
  if (!run) throw new Error("Could not create schedule-change fixture ingestion run");
  return run.id;
}

test("snapshot provenance rejects missing suffixes and allows every real run status", async () => {
  const statuses = [
    { status: "queued", errorMessage: null },
    { status: "running", errorMessage: null },
    { status: "completed", errorMessage: null },
    { status: "failed", errorMessage: null },
    { status: "failed", errorMessage: "Ingestion interrupted by an API server restart" },
  ];
  const runIds: number[] = [];

  try {
    const runs = await db
      .insert(ingestionRunsTable)
      .values(statuses.map((status) => ({
        ...status,
        mode: "current",
        scheduleDate: "2026-08-30",
        authorityScope: runtimeAuthorityScope(),
      })))
      .returning({ id: ingestionRunsTable.id });
    runIds.push(...runs.map((run) => run.id));
    const ingestionRunIds = new Set(runIds);

    for (const runId of runIds) {
      assert.equal(
        isAuthoritativeStagedSnapshot({
          requestKey: `items-snapshot:schedule-123456:run-${runId}`,
          effectiveDate: "2026-08-01",
          ingestionRunIds,
        }),
        true,
      );
    }
    assert.equal(
      isAuthoritativeStagedSnapshot({
        requestKey: "items-snapshot:schedule-123456",
        effectiveDate: "2026-08-01",
        ingestionRunIds: new Set([0, ...runIds]),
      }),
      false,
    );
    assert.equal(
      isAuthoritativeStagedSnapshot({
        requestKey: "items-snapshot:schedule-123456:run-not-a-number",
        effectiveDate: "2026-08-01",
        ingestionRunIds: new Set([0, ...runIds]),
      }),
      false,
    );
  } finally {
    if (runIds.length > 0) {
      await db.delete(ingestionRunsTable).where(inArray(ingestionRunsTable.id, runIds));
    }
  }
});

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
  const fixtureBase = 1_500_000_000 + ((Date.now() + process.pid) % 100_000_000);

  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const previousScheduleCode = fixtureBase + scenarioIndex * 2;
    const currentScheduleCode = previousScheduleCode + 1;
    const drugId = fixtureBase + scenarioIndex;
    const scheduleDate = `${2090 + ((Date.now() + process.pid) % 1000)}-0${scenarioIndex + 1}-01`;
    const effectiveDates = [`2026-0${scenarioIndex + 1}-01`, `2026-0${scenarioIndex + 1}-02`];
    const runIds: number[] = [];

    try {
      runIds.push(await createFixtureIngestionRun("completed"));
      runIds.push(await createFixtureIngestionRun("completed"));
      await db.insert(drugsTable).values({
        id: drugId,
        name: "Task 32 fixture drug",
        activeIngredient: "Task 32 fixture ingredient",
        sponsor: "Task 32 fixture",
        firstPbsListingDate: "2090-01-01",
        authorityScope: runtimeAuthorityScope(),
      });
      await stageFixtureSchedule({
        scheduleCode: previousScheduleCode,
        effectiveDate: effectiveDates[0],
        scheduleDate,
        items: fixtureItems,
        coverage: "complete",
        stagingRunId: runIds[0],
      });
      await stageFixtureSchedule({
        scheduleCode: currentScheduleCode,
        effectiveDate: effectiveDates[1],
        scheduleDate,
        items: [fixtureItems[1]],
        coverage: scenario.coverage,
        stagingRunId: runIds[1],
      });

      await syncScheduleChangesFromStagedData({
        scheduleCodes: [previousScheduleCode, currentScheduleCode],
        authorityRunId: runIds[1]!,
      });
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
      if (runIds.length > 0) {
        await db.delete(ingestionRunsTable).where(inArray(ingestionRunsTable.id, runIds));
      }
    }
  }
});

test("interrupted schedule-wide staging stays incomplete when a later run uses the same schedule", async () => {
  const previousScheduleCode = 1_900_000_001 + ((Date.now() + process.pid) % 100_000_000);
  const currentScheduleCode = previousScheduleCode + 1;
  const drugId = previousScheduleCode;
  const scheduleDate = `${2092 + ((Date.now() + process.pid) % 1000)}-01-01`;
  const effectiveDates = ["2026-04-01", "2026-05-01"];
  const runIds: number[] = [];

  try {
    runIds.push(await createFixtureIngestionRun("failed"));
    runIds.push(await createFixtureIngestionRun("running"));
    const [interruptedRunId, laterRunId] = runIds;
    assert.ok(interruptedRunId);
    assert.ok(laterRunId);
    await db.insert(drugsTable).values({
      id: drugId,
      name: "Task 33 fixture drug",
      activeIngredient: "Task 32 fixture ingredient",
      sponsor: "Task 33 fixture",
      firstPbsListingDate: "2090-01-01",
        authorityScope: runtimeAuthorityScope(),
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
    assert.equal(
      await syncScheduleChangesFromStagedData({
        scheduleCodes: [previousScheduleCode, currentScheduleCode],
        authorityRunId: laterRunId,
      }),
      0,
    );
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
    if (runIds.length > 0) {
      await db.delete(ingestionRunsTable).where(inArray(ingestionRunsTable.id, runIds));
    }
  }
});

test("ignores complete staged snapshots whose run does not exist", async () => {
  const fixtureBase = 1_700_000_000 + ((Date.now() + process.pid) % 100_000_000);
  const previousScheduleCode = fixtureBase;
  const currentScheduleCode = fixtureBase + 1;
  const nonexistentRunId = fixtureBase + 100;
  const drugId = fixtureBase;
  const scheduleDate = `${3090 + ((Date.now() + process.pid) % 500)}-06-01`;
  let previousRunId: number | undefined;

  try {
    previousRunId = await createFixtureIngestionRun("completed");
    await db.insert(drugsTable).values({
      id: drugId,
      name: "Missing run fixture drug",
      activeIngredient: "Task 32 fixture ingredient",
      sponsor: "Schedule change tests",
      firstPbsListingDate: "2020-01-01",
        authorityScope: runtimeAuthorityScope(),
    });
    await stageFixtureSchedule({
      scheduleCode: previousScheduleCode,
      effectiveDate: "2026-06-01",
      scheduleDate,
      items: fixtureItems,
      coverage: "complete",
      stagingRunId: previousRunId,
    });
    await stageFixtureSchedule({
      scheduleCode: currentScheduleCode,
      effectiveDate: "2026-07-01",
      scheduleDate,
      items: [fixtureItems[1]],
      coverage: "complete",
      stagingRunId: nonexistentRunId,
    });

    assert.equal(
      await syncScheduleChangesFromStagedData({
        scheduleCodes: [previousScheduleCode, currentScheduleCode],
        authorityRunId: previousRunId,
      }),
      0,
    );
    const changes = await db
      .select({ id: scheduleChangesTable.id })
      .from(scheduleChangesTable)
      .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, currentScheduleCode]));
    assert.equal(changes.length, 0);
  } finally {
    await db
      .delete(scheduleChangesTable)
      .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, currentScheduleCode]));
    await db.delete(rawScheduleStagingTable).where(eq(rawScheduleStagingTable.scheduleDate, scheduleDate));
    await db.delete(pbsItemsTable).where(eq(pbsItemsTable.drugId, drugId));
    await db.delete(drugsTable).where(eq(drugsTable.id, drugId));
    if (previousRunId !== undefined) {
      await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, previousRunId));
    }
  }
});

test("ignores implausibly future complete snapshots even when their run exists", async () => {
  const fixtureBase = 1_750_000_000 + ((Date.now() + process.pid) % 100_000_000);
  const previousScheduleCode = fixtureBase;
  const currentScheduleCode = fixtureBase + 1;
  const drugId = fixtureBase;
  const scheduleDate = `${3590 + ((Date.now() + process.pid) % 300)}-07-01`;
  const runIds: number[] = [];

  try {
    runIds.push(await createFixtureIngestionRun("completed"));
    runIds.push(await createFixtureIngestionRun("completed"));
    await db.insert(drugsTable).values({
      id: drugId,
      name: "Future schedule fixture drug",
      activeIngredient: "Task 32 fixture ingredient",
      sponsor: "Schedule change tests",
      firstPbsListingDate: "2020-01-01",
        authorityScope: runtimeAuthorityScope(),
    });
    await stageFixtureSchedule({
      scheduleCode: previousScheduleCode,
      effectiveDate: "2026-08-01",
      scheduleDate,
      items: fixtureItems,
      coverage: "complete",
      stagingRunId: runIds[0],
    });
    await stageFixtureSchedule({
      scheduleCode: currentScheduleCode,
      effectiveDate: "2092-01-01",
      scheduleDate,
      items: [fixtureItems[1]],
      coverage: "complete",
      stagingRunId: runIds[1],
    });

    assert.equal(
      await syncScheduleChangesFromStagedData({
        scheduleCodes: [previousScheduleCode, currentScheduleCode],
        authorityRunId: runIds[1]!,
      }),
      0,
    );
  } finally {
    await db
      .delete(scheduleChangesTable)
      .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, currentScheduleCode]));
    await db.delete(rawScheduleStagingTable).where(eq(rawScheduleStagingTable.scheduleDate, scheduleDate));
    await db.delete(pbsItemsTable).where(eq(pbsItemsTable.drugId, drugId));
    await db.delete(drugsTable).where(eq(drugsTable.id, drugId));
    if (runIds.length > 0) {
      await db.delete(ingestionRunsTable).where(inArray(ingestionRunsTable.id, runIds));
    }
  }
});

test("accepts complete staged snapshots from a currently running ingestion run", async () => {
  const fixtureBase = 1_800_000_000 + ((Date.now() + process.pid) % 100_000_000);
  const previousScheduleCode = fixtureBase;
  const currentScheduleCode = fixtureBase + 1;
  const drugId = fixtureBase;
  const scheduleDate = `${3890 + ((Date.now() + process.pid) % 100)}-08-01`;
  const runIds: number[] = [];

  try {
    runIds.push(await createFixtureIngestionRun("completed"));
    runIds.push(await createFixtureIngestionRun("running"));
    await db.insert(drugsTable).values({
      id: drugId,
      name: "Running run fixture drug",
      activeIngredient: "Task 32 fixture ingredient",
      sponsor: "Schedule change tests",
      firstPbsListingDate: "2020-01-01",
        authorityScope: runtimeAuthorityScope(),
    });
    await stageFixtureSchedule({
      scheduleCode: previousScheduleCode,
      effectiveDate: "2026-08-01",
      scheduleDate,
      items: fixtureItems,
      coverage: "complete",
      stagingRunId: runIds[0],
    });
    await stageFixtureSchedule({
      scheduleCode: currentScheduleCode,
      effectiveDate: "2026-09-01",
      scheduleDate,
      items: [fixtureItems[1]],
      coverage: "complete",
      stagingRunId: runIds[1],
    });

    assert.equal(
      await syncScheduleChangesFromStagedData({
        scheduleCodes: [previousScheduleCode, currentScheduleCode],
        authorityRunId: runIds[1]!,
      }),
      1,
    );
    const changes = await db
      .select({
        changeType: scheduleChangesTable.changeType,
        liItemId: scheduleChangesTable.liItemId,
      })
      .from(scheduleChangesTable)
      .where(eq(scheduleChangesTable.scheduleCode, currentScheduleCode));
    assert.deepEqual(changes, [{ changeType: "delisted", liItemId: "task-32-removed" }]);
  } finally {
    await db
      .delete(scheduleChangesTable)
      .where(inArray(scheduleChangesTable.scheduleCode, [previousScheduleCode, currentScheduleCode]));
    await db.delete(rawScheduleStagingTable).where(eq(rawScheduleStagingTable.scheduleDate, scheduleDate));
    await db.delete(pbsItemsTable).where(eq(pbsItemsTable.drugId, drugId));
    await db.delete(drugsTable).where(eq(drugsTable.id, drugId));
    if (runIds.length > 0) {
      await db.delete(ingestionRunsTable).where(inArray(ingestionRunsTable.id, runIds));
    }
  }
});