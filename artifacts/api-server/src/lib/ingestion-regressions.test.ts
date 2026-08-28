import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  db,
  drugsTable,
  pbsItemsTable,
  pbsPublishedFilesTable,
  pbsPublishedPricesTable,
  pool,
  predictedReductionsTable,
  priceHistoryTable,
  scheduleChangesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { upsertPbsItemsFromPayload } from "./pbs-item-mapping";
import { recalculatePredictedReductionsForDrug } from "./predicted-reductions";

let fixtureNumber = 0;

function newFixture() {
  fixtureNumber += 1;
  const token = `regression_${process.pid}_${fixtureNumber}_${Date.now()}`;
  return {
    token,
    drugId: 1_800_000_000 + (process.pid % 100_000) * 100 + fixtureNumber,
  };
}

function pbsItemValues(input: {
  itemCode: string;
  drugId: number;
  pbsCode?: string;
  formulary?: "F1" | "F2";
  currentAemp?: number;
}) {
  return {
    itemCode: input.itemCode,
    pbsCode: input.pbsCode ?? `PBS-${input.itemCode}`,
    liItemId: input.itemCode,
    scheduleCode: 900_001,
    drugId: input.drugId,
    brandName: `Regression brand ${input.itemCode}`,
    strength: "10 mg",
    form: "tablet",
    packSize: "30",
    pricingQuantity: null,
    benefitTypeCode: "S",
    maximumQuantityUnits: 30,
    liForm: "Tablet 10 mg",
    programCode: "GE",
    formulary: input.formulary ?? "F2",
    currentAemp: input.currentAemp ?? 100,
    currentDpmq: null,
    lastUpdated: "2026-01-01",
    firstListedDate: "2020-01-01",
    weightedAvgDisclosedPrice: null,
    originatorBrandIndicator: null,
    brandSubstitutionGroupId: null,
    advancedNoticeDate: null,
    nonEffectiveDate: null,
    determinedPrice: input.currentAemp ?? 100,
    claimedPrice: null,
    proportionalPrice: null,
    therapeuticGroupId: null,
    innovatorIndicator: null,
  };
}

function pbsItemPayload(itemCode: string, scheduleCode: number, determinedPrice = 100) {
  return {
    data: [
      {
        li_item_id: itemCode,
        pbs_code: `PBS-${itemCode}`,
        drug_name: `Regression ingredient ${itemCode}`,
        brand_name: `Regression brand ${itemCode}`,
        formulary: "F2",
        schedule_code: scheduleCode,
        determined_price: determinedPrice,
        first_listed_date: "2020-01-01",
        li_form: "Tablet 10 mg",
      },
    ],
  };
}

async function cleanupFixture(input: {
  itemCodes: string[];
  drugIds: number[];
  fileIds?: number[];
  scheduleChangeIds?: number[];
}) {
  const { itemCodes, drugIds, fileIds = [], scheduleChangeIds = [] } = input;
  if (drugIds.length > 0) {
    await db.delete(predictedReductionsTable).where(inArray(predictedReductionsTable.drugId, drugIds));
    await db.delete(scheduleChangesTable).where(inArray(scheduleChangesTable.drugId, drugIds));
  }
  if (itemCodes.length > 0) {
    await db.delete(pbsPublishedPricesTable).where(inArray(pbsPublishedPricesTable.matchedItemCode, itemCodes));
    await db.delete(priceHistoryTable).where(inArray(priceHistoryTable.itemCode, itemCodes));
    await db.delete(pbsItemsTable).where(inArray(pbsItemsTable.itemCode, itemCodes));
  }
  if (fileIds.length > 0) {
    await db.delete(pbsPublishedFilesTable).where(inArray(pbsPublishedFilesTable.id, fileIds));
  }
  if (drugIds.length > 0) {
    await db.delete(drugsTable).where(inArray(drugsTable.id, drugIds));
  }
  if (scheduleChangeIds.length > 0) {
    await db.delete(scheduleChangesTable).where(inArray(scheduleChangesTable.id, scheduleChangeIds));
  }
}

test("re-ingesting the same schedule does not add duplicate price history", async () => {
  const fixture = newFixture();
  const itemCode = `${fixture.token}_ITEM`;
  const scheduleCode = 900_101;
  const scheduleDate = "2026-02-01";
  const scheduleEffectiveDate = "2026-02-01";

  try {
    await upsertPbsItemsFromPayload(
      {
        data: [
          {
            ...pbsItemPayload(itemCode, scheduleCode).data[0],
            drug_name: `Regression ingredient ${itemCode}`,
          },
        ],
      },
      scheduleDate,
      scheduleEffectiveDate,
    );
    const afterFirstIngest = await db
      .select({ id: priceHistoryTable.id })
      .from(priceHistoryTable)
      .where(eq(priceHistoryTable.itemCode, itemCode));

    await upsertPbsItemsFromPayload(
      {
        data: [
          {
            ...pbsItemPayload(itemCode, scheduleCode).data[0],
            drug_name: `Regression ingredient ${itemCode}`,
          },
        ],
      },
      scheduleDate,
      scheduleEffectiveDate,
    );
    const afterSecondIngest = await db
      .select({ id: priceHistoryTable.id })
      .from(priceHistoryTable)
      .where(eq(priceHistoryTable.itemCode, itemCode));

    assert.equal(afterFirstIngest.length, 1);
    assert.equal(afterSecondIngest.length, afterFirstIngest.length);
  } finally {
    const [drug] = await db
      .select({ id: drugsTable.id })
      .from(drugsTable)
      .where(eq(drugsTable.activeIngredient, `Regression ingredient ${itemCode}`))
      .limit(1);
    await cleanupFixture({ itemCodes: [itemCode], drugIds: drug ? [drug.id] : [] });
  }
});

test("a single-brand first-new-brand event predicts the configured 25 percent reduction", async () => {
  const fixture = newFixture();
  const itemCode = `${fixture.token}_ITEM`;
  const item = pbsItemValues({
    itemCode,
    drugId: fixture.drugId,
    formulary: "F1",
    currentAemp: 100,
  });
  let scheduleChangeId: number | undefined;

  try {
    await db.insert(drugsTable).values({
      id: fixture.drugId,
      name: `Regression drug ${fixture.token}`,
      activeIngredient: `Regression ingredient ${fixture.token}`,
      sponsor: "Regression tests",
      firstPbsListingDate: "2020-01-01",
    });
    await db.insert(pbsItemsTable).values(item);
    [scheduleChangeId] = await db
      .insert(scheduleChangesTable)
      .values({
        scheduleCode: 900_102,
        effectiveDate: "2026-06-01",
        changeType: "new_brand",
        liItemId: null,
        pbsCode: null,
        drugId: fixture.drugId,
        brandName: null,
        oldValue: {
          brands: ["Only existing brand"],
          baseline_items: [{ li_item_id: itemCode, determined_price: 100 }],
        },
        newValue: { brands: ["Only existing brand", "New brand"] },
        affectedItems: null,
        significance: "high",
        notes: "Regression fixture",
      })
      .returning({ id: scheduleChangesTable.id });

    await recalculatePredictedReductionsForDrug(fixture.drugId, "2026-01-01");
    const predictions = await db
      .select({
        itemCode: predictedReductionsTable.itemCode,
        predictedPercentage: predictedReductionsTable.predictedPercentage,
        predictedNewPrice: predictedReductionsTable.predictedNewPrice,
        reductionType: predictedReductionsTable.reductionType,
      })
      .from(predictedReductionsTable)
      .where(
        and(
          eq(predictedReductionsTable.drugId, fixture.drugId),
          eq(predictedReductionsTable.reductionType, "First New Brand statutory reduction"),
        ),
      );

    assert.deepEqual(predictions, [
      {
        itemCode,
        predictedPercentage: 25,
        predictedNewPrice: 75,
        reductionType: "First New Brand statutory reduction",
      },
    ]);
  } finally {
    await cleanupFixture({
      itemCodes: [itemCode],
      drugIds: [fixture.drugId],
      scheduleChangeIds: scheduleChangeId ? [scheduleChangeId] : [],
    });
  }
});

test("indicative prices produce one prediction per item and date without fanning out", async () => {
  const fixture = newFixture();
  const itemCodes = [`${fixture.token}_ITEM_A`, `${fixture.token}_ITEM_B`];
  const fileIds: number[] = [];
  const predictedDate = "2027-04-01";

  try {
    await db.insert(drugsTable).values({
      id: fixture.drugId,
      name: `Regression drug ${fixture.token}`,
      activeIngredient: `Regression ingredient ${fixture.token}`,
      sponsor: "Regression tests",
      firstPbsListingDate: "2020-01-01",
    });
    await db.insert(pbsItemsTable).values(
      itemCodes.map((itemCode) =>
        pbsItemValues({ itemCode, drugId: fixture.drugId, formulary: "F2" }),
      ),
    );
    const files = await db
      .insert(pbsPublishedFilesTable)
      .values(
        [1, 2].map((index) => ({
          sourceKey: `${fixture.token}_INDICATIVE_${index}`,
          pageUrl: "https://example.test/page",
          fileUrl: `https://example.test/file-${index}.xlsx`,
          fileName: `fixture-${index}.xlsx`,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          fileSha256: `${fixture.token}_${index}`,
          rawContentBase64: "",
          parserVersion: "regression-test",
          status: "completed",
          totalRows: 2,
          matchedRows: 2,
          watchlistUnmatchedRows: 0,
          errorMessage: null,
          metadata: null,
          isCurrent: true,
        })),
      )
      .returning({ id: pbsPublishedFilesTable.id });
    fileIds.push(...files.map((file) => file.id));

    await db.insert(pbsPublishedPricesTable).values(
      files.flatMap((file, fileIndex) =>
        itemCodes.map((itemCode, itemIndex) => ({
          fileId: file.id,
          sourceRowNumber: itemIndex + 2,
          sourceItemCode: `SOURCE-${fileIndex}-${itemIndex}`,
          matchedItemCode: itemCode,
          drugId: fixture.drugId,
          legalInstrumentDrug: `Regression ingredient ${fixture.token}`,
          legalInstrumentMoa: "Oral",
          brandName: `Regression brand ${itemCode}`,
          currentAemp: 100,
          newAemp: 90,
          predictedDate,
          confidence: "indicative",
        })),
      ),
    );

    await recalculatePredictedReductionsForDrug(fixture.drugId, "2026-01-01");
    const predictions = await db
      .select({
        itemCode: predictedReductionsTable.itemCode,
        predictedDate: predictedReductionsTable.predictedDate,
      })
      .from(predictedReductionsTable)
      .where(
        and(
          eq(predictedReductionsTable.drugId, fixture.drugId),
          eq(predictedReductionsTable.predictedDate, predictedDate),
        ),
      );

    assert.equal(predictions.length, itemCodes.length);
    assert.deepEqual(
      predictions.map((prediction) => prediction.itemCode).sort(),
      [...itemCodes].sort(),
    );
    assert.equal(new Set(predictions.map((prediction) => `${prediction.itemCode}:${prediction.predictedDate}`)).size, 2);
  } finally {
    await cleanupFixture({ itemCodes, drugIds: [fixture.drugId], fileIds });
  }
});

test("backfilling an existing item leaves the PBS item count unchanged", async () => {
  const fixture = newFixture();
  const itemCode = `${fixture.token}_ITEM`;
  const scheduleCode = 900_104;

  try {
    await db.insert(drugsTable).values({
      id: fixture.drugId,
      name: `Regression drug ${fixture.token}`,
      activeIngredient: `Regression ingredient ${fixture.token}`,
      sponsor: "Regression tests",
      firstPbsListingDate: "2020-01-01",
    });
    await db.insert(pbsItemsTable).values(pbsItemValues({ itemCode, drugId: fixture.drugId }));
    const before = await db
      .select({ itemCode: pbsItemsTable.itemCode })
      .from(pbsItemsTable)
      .where(eq(pbsItemsTable.drugId, fixture.drugId));

    await upsertPbsItemsFromPayload(
      pbsItemPayload(itemCode, scheduleCode, 95),
      "2026-01-01",
      "2025-01-01",
      { scheduleCode, updateCurrentItem: false },
    );
    const after = await db
      .select({ itemCode: pbsItemsTable.itemCode })
      .from(pbsItemsTable)
      .where(eq(pbsItemsTable.drugId, fixture.drugId));

    assert.equal(before.length, 1);
    assert.equal(after.length, before.length);
    assert.deepEqual(after.map((row) => row.itemCode), before.map((row) => row.itemCode));
  } finally {
    await cleanupFixture({ itemCodes: [itemCode], drugIds: [fixture.drugId] });
  }
});

after(async () => {
  await pool.end();
});