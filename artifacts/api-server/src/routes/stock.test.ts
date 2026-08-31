import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  artgEntriesTable,
  db,
  drugsTable,
  ingestionRunsTable,
  pharmacyBrandPreferencesTable,
  pharmacyStockTable,
  pbsItemsTable,
  pool,
  predictedReductionsTable,
  PRODUCTION_AUTHORITY_SCOPE,
  scheduleChangesTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { normalizeBrandName } from "../lib/brand-preferences";
import { createReferenceRouter } from "./reference";
import { createStockRouter, dashboardPriceReduction } from "./stock";

const userA = "clerk_test_pharmacy_a";
const userB = "clerk_test_pharmacy_b";
let fixtureNumber = 0;
let baseUrl = "";
let server: Server;

const testAuth = ((req, _res, next) => {
  const userId = req.header("x-test-user");
  if (!userId) {
    throw new Error("Test requests must include x-test-user");
  }
  req.userId = userId;
  next();
}) as typeof requireAuth;

test("dashboard price reductions only include a strictly lower determined price", () => {
  assert.equal(dashboardPriceReduction({ determined_price: 100 }, { determined_price: 99 }), true);
  assert.equal(dashboardPriceReduction({ determined_price: 100 }, { determined_price: 100 }), false);
  assert.equal(dashboardPriceReduction({ determined_price: 99 }, { determined_price: 100 }), false);
});

test("dashboard tolerates a complete run with no finished timestamp", async () => {
  const scheduleCode = 980_000 + fixtureNumber;
  const scheduleEffectiveDate = new Date().toISOString().slice(0, 10);
  let runId: number | undefined;

  try {
    const [run] = await db
      .insert(ingestionRunsTable)
      .values({
        status: "completed",
        recordsProcessed: 0,
        pagesFetched: 0,
        requestUrls: [],
        scheduleCode,
        scheduleEffectiveDate,
        snapshotComplete: true,
        finishedAt: null,
        authorityScope: PRODUCTION_AUTHORITY_SCOPE,
      })
      .returning({ id: ingestionRunsTable.id });
    assert.ok(run);
    runId = run.id;

    const response = await request(userA, "/dashboard");
    assert.equal(response.status, 200);
    const dashboard = (await response.json()) as {
      currentSchedule: { lastSuccessfulIngestionAt: string | null };
    };
    assert.ok("lastSuccessfulIngestionAt" in dashboard.currentSchedule);
  } finally {
    if (runId !== undefined) {
      await db
        .delete(ingestionRunsTable)
        .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, PRODUCTION_AUTHORITY_SCOPE)));
    }
  }
});

function newFixtureToken() {
  fixtureNumber += 1;
  return `T21_${process.pid}_${fixtureNumber}_${Date.now()}`;
}

function futureDate(daysFromNow: number) {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function seedItem(itemCode: string, drugId: number) {
  await db.insert(drugsTable).values({
    id: drugId,
    name: `Task 21 test drug ${itemCode}`,
    activeIngredient: "test ingredient",
    sponsor: "Task 21 tests",
    firstPbsListingDate: "2025-01-01",
    authorityScope: PRODUCTION_AUTHORITY_SCOPE,
  });
  await db.insert(pbsItemsTable).values({
    itemCode,
    pbsCode: `PBS-${itemCode}`,
    liItemId: null,
    scheduleCode: null,
    drugId,
    brandName: `Task 21 brand ${itemCode}`,
    strength: "10 mg",
    form: "tablet",
    packSize: "30",
    pricingQuantity: null,
    liForm: null,
    programCode: null,
    formulary: "F1",
    currentAemp: 100,
    currentDpmq: null,
    lastUpdated: "2025-01-01",
    firstListedDate: "2025-01-01",
    weightedAvgDisclosedPrice: null,
    originatorBrandIndicator: null,
    brandSubstitutionGroupId: null,
    advancedNoticeDate: null,
    nonEffectiveDate: null,
    determinedPrice: null,
    claimedPrice: null,
    proportionalPrice: null,
    therapeuticGroupId: null,
    innovatorIndicator: null,
    authorityScope: PRODUCTION_AUTHORITY_SCOPE,
  });
}

function monthsFromDate(dateValue: string, months: number) {
  const [year, month, day] = dateValue.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, day)).toISOString().slice(0, 10);
}

function daysFromDate(dateValue: string, days: number) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day));
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

async function seedDashboardItem(
  itemCode: string,
  drugId: number,
  brandName: string,
  liItemId: string,
) {
  await db.insert(pbsItemsTable).values({
    itemCode,
    pbsCode: `PBS-${itemCode}`,
    liItemId,
    scheduleCode: 900,
    drugId,
    brandName,
    strength: "10 mg",
    form: "tablet",
    packSize: "30",
    pricingQuantity: null,
    liForm: null,
    programCode: null,
    formulary: "F1",
    currentAemp: 100,
    currentDpmq: null,
    lastUpdated: "2026-01-01",
    firstListedDate: "2026-01-01",
    weightedAvgDisclosedPrice: null,
    originatorBrandIndicator: null,
    brandSubstitutionGroupId: null,
    advancedNoticeDate: null,
    nonEffectiveDate: null,
    determinedPrice: null,
    claimedPrice: null,
    proportionalPrice: null,
    therapeuticGroupId: null,
    innovatorIndicator: null,
    authorityScope: PRODUCTION_AUTHORITY_SCOPE,
  });
}

async function seedDashboardChange(input: {
  scheduleCode: number;
  effectiveDate: string;
  changeType: string;
  drugId: number;
  brandName: string | null;
  liItemId: string;
  oldValue?: unknown;
  newValue?: unknown;
  authorityRunId: number;
}) {
  await db.insert(scheduleChangesTable).values({
    scheduleCode: input.scheduleCode,
    effectiveDate: input.effectiveDate,
    changeType: input.changeType,
    liItemId: input.liItemId,
    pbsCode: `PBS-${input.liItemId}`,
    drugId: input.drugId,
    brandName: input.brandName,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    affectedItems: null,
    significance: "normal",
    notes: "Dashboard boundary fixture",
    authorityRunId: input.authorityRunId,
  });
}

async function seedStock(userId: string, itemCode: string, quantity: number, purchasePrice: number) {
  const [stock] = await db
    .insert(pharmacyStockTable)
    .values({
      userId,
      itemCode,
      quantity,
      purchasePrice,
      purchaseDate: "2026-01-01",
      invoiceReference: null,
    })
    .returning({ id: pharmacyStockTable.id });
  assert.ok(stock);
  return stock.id;
}

async function seedPrediction(
  itemCode: string,
  drugId: number,
  predictedDate: string,
  predictedNewPrice: number,
  confidence: string,
  authorityRunId: number,
) {
  await db.insert(predictedReductionsTable).values({
    itemCode,
    drugId,
    predictedDate,
    reductionType: "test reduction",
    predictedPercentage: 10,
    predictedNewPrice,
    confidence,
    subjectToMinisterialDiscretion: false,
    sourceNote: "Task 21 test fixture",
    authorityRunId,
  });
}

async function cleanupFixture(
  itemCodes: string[],
  drugIds: number[],
  artgIds: string[] = [],
  runIds: number[] = [],
) {
  const authorityScope = PRODUCTION_AUTHORITY_SCOPE;
  if (runIds.length) {
    await db
      .delete(predictedReductionsTable)
      .where(and(inArray(predictedReductionsTable.itemCode, itemCodes), inArray(predictedReductionsTable.authorityRunId, runIds)));
    await db
      .delete(scheduleChangesTable)
      .where(and(inArray(scheduleChangesTable.drugId, drugIds), inArray(scheduleChangesTable.authorityRunId, runIds)));
  }
  if (artgIds.length) await db.delete(artgEntriesTable).where(inArray(artgEntriesTable.artgId, artgIds));
  await db.delete(pharmacyBrandPreferencesTable).where(inArray(pharmacyBrandPreferencesTable.drugId, drugIds));
  await db.delete(pharmacyStockTable).where(inArray(pharmacyStockTable.itemCode, itemCodes));
  await db.delete(pbsItemsTable).where(and(inArray(pbsItemsTable.itemCode, itemCodes), eq(pbsItemsTable.authorityScope, authorityScope)));
  await db.delete(drugsTable).where(and(inArray(drugsTable.id, drugIds), eq(drugsTable.authorityScope, authorityScope)));
  if (runIds.length) {
    await db
      .delete(ingestionRunsTable)
      .where(and(inArray(ingestionRunsTable.id, runIds), eq(ingestionRunsTable.authorityScope, authorityScope)));
  }
}

async function request(userId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", userId);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(createReferenceRouter(db, testAuth));
  app.use(createStockRouter(db, testAuth));
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
});

test("authenticated dashboard counts stay correct across schedule boundaries and detail filters", async () => {
  const token = newFixtureToken();
  const itemCodes = [`${token}_VISIBLE`, `${token}_HIDDEN`];
  const drugId = 2_100_000_000 + (process.pid % 100_000) * 10 + fixtureNumber;
  const drugIds = [drugId];
  const artgIds = [
    `${token}_ARTG_CURRENT`,
    `${token}_ARTG_THREE_MONTHS`,
    `${token}_ARTG_TWELVE_MONTHS`,
    `${token}_ARTG_MATCHED_VISIBLE`,
    `${token}_ARTG_MATCHED_HIDDEN`,
    `${token}_ARTG_CANCELLED`,
  ];
  const runIds: number[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const threeMonthsAgo = monthsFromDate(today, -3);
  const twelveMonthsAgo = monthsFromDate(today, -12);
  const scheduleDate = daysFromDate(today, -7);
  const scheduleCode = 900_000 + fixtureNumber;
  const visibleBrand = `${token} visible brand`;
  const hiddenBrand = `${token} hidden brand`;
  const visibleItem = itemCodes[0];
  const hiddenItem = itemCodes[1];
  assert.ok(visibleItem);
  assert.ok(hiddenItem);

  try {
    await db.insert(drugsTable).values({
      id: drugId,
      name: `${token} dashboard medicine`,
      activeIngredient: `${token} ingredient`,
      sponsor: "Dashboard boundary fixture",
      firstPbsListingDate: twelveMonthsAgo,
      authorityScope: PRODUCTION_AUTHORITY_SCOPE,
    });
    await seedDashboardItem(visibleItem, drugId, visibleBrand, `${token}_LI_VISIBLE`);
    await seedDashboardItem(hiddenItem, drugId, hiddenBrand, `${token}_LI_HIDDEN`);
    await db.insert(pharmacyBrandPreferencesTable).values({
      userId: userA,
      drugId,
      brandKey: normalizeBrandName(hiddenBrand),
      brandName: hiddenBrand,
      hidden: true,
    });

    const [latestCompleteRun] = await db
      .select({ finishedAt: ingestionRunsTable.finishedAt })
      .from(ingestionRunsTable)
      .where(
        and(
          eq(ingestionRunsTable.status, "completed"),
          eq(ingestionRunsTable.snapshotComplete, true),
          eq(ingestionRunsTable.authorityScope, PRODUCTION_AUTHORITY_SCOPE),
        ),
      )
      .orderBy(desc(ingestionRunsTable.finishedAt))
      .limit(1);
    const completedAt = latestCompleteRun?.finishedAt
      ? new Date(latestCompleteRun.finishedAt.getTime() + 1)
      : new Date();
    const [completedRun] = await db
      .insert(ingestionRunsTable)
      .values({
        status: "completed",
        recordsProcessed: 2,
        pagesFetched: 1,
        requestUrls: [],
        scheduleCode,
        scheduleEffectiveDate: scheduleDate,
        snapshotComplete: true,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: completedAt,
        authorityScope: PRODUCTION_AUTHORITY_SCOPE,
      })
      .returning({ id: ingestionRunsTable.id });
    assert.ok(completedRun);
    runIds.push(completedRun.id);
    const baselineResponse = await request(userA, "/dashboard");
    assert.equal(baselineResponse.status, 200);
    const baselineDashboard = (await baselineResponse.json()) as {
      periods: Array<{ key: string; available: boolean; counts: Record<string, number> }>;
    };
    assert.ok(baselineDashboard.periods.every((period) => period.available));

    await seedDashboardChange({
      scheduleCode,
      authorityRunId: completedRun.id,
      effectiveDate: scheduleDate,
      changeType: "new_brand",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_VISIBLE_NEW`,
    });
    await seedDashboardChange({
      scheduleCode,
      authorityRunId: completedRun.id,
      effectiveDate: scheduleDate,
      changeType: "new_brand",
      drugId,
      brandName: hiddenBrand,
      liItemId: `${token}_LI_HIDDEN_NEW`,
    });
    await seedDashboardChange({
      scheduleCode,
      authorityRunId: completedRun.id,
      effectiveDate: scheduleDate,
      changeType: "price_change",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_VISIBLE_PRICE_DOWN`,
      oldValue: { determined_price: 100 },
      newValue: { determined_price: 90 },
    });
    await seedDashboardChange({
      scheduleCode,
      authorityRunId: completedRun.id,
      effectiveDate: scheduleDate,
      changeType: "price_change",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_VISIBLE_PRICE_UP`,
      oldValue: { determined_price: 100 },
      newValue: { determined_price: 110 },
    });
    await seedDashboardChange({
      scheduleCode,
      authorityRunId: completedRun.id,
      effectiveDate: scheduleDate,
      changeType: "delisted",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_VISIBLE_DELISTED`,
    });
    await seedDashboardChange({
      scheduleCode,
      authorityRunId: completedRun.id,
      effectiveDate: scheduleDate,
      changeType: "delisted",
      drugId,
      brandName: hiddenBrand,
      liItemId: `${token}_LI_HIDDEN_DELISTED`,
    });
    await seedDashboardChange({
      scheduleCode,
      authorityRunId: completedRun.id,
      effectiveDate: scheduleDate,
      changeType: "formulary_change",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_VISIBLE_FORMULARY`,
    });
    await seedDashboardChange({
      scheduleCode,
      authorityRunId: completedRun.id,
      effectiveDate: scheduleDate,
      changeType: "listing_amendment",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_VISIBLE_AMENDMENT`,
    });
    await seedDashboardChange({
      scheduleCode: 899,
      authorityRunId: completedRun.id,
      effectiveDate: threeMonthsAgo,
      changeType: "new_brand",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_THREE_MONTHS`,
    });
    await seedDashboardChange({
      scheduleCode: 898,
      authorityRunId: completedRun.id,
      effectiveDate: twelveMonthsAgo,
      changeType: "new_brand",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_TWELVE_MONTHS`,
    });
    await seedDashboardChange({
      scheduleCode: 897,
      authorityRunId: completedRun.id,
      effectiveDate: daysFromDate(threeMonthsAgo, -1),
      changeType: "delisted",
      drugId,
      brandName: visibleBrand,
      liItemId: `${token}_LI_OUTSIDE_THREE_MONTHS`,
    });

    await seedPrediction(visibleItem, drugId, today, 90, "confirmed", completedRun.id);
    await seedPrediction(visibleItem, drugId, monthsFromDate(today, 3), 80, "confirmed", completedRun.id);
    await seedPrediction(visibleItem, drugId, monthsFromDate(today, 12), 70, "confirmed", completedRun.id);
    await seedPrediction(hiddenItem, drugId, today, 60, "confirmed", completedRun.id);

    await db.insert(artgEntriesTable).values([
      {
        artgId: artgIds[0],
        activeIngredient: `${token} ingredient`,
        normalizedIngredient: `${token.toLocaleLowerCase()} ingredient`,
        matchedDrugId: drugId,
        sponsor: "Dashboard boundary fixture",
        registrationDate: scheduleDate,
        productName: `${token} unmatched current product`,
        status: "REGISTERED",
      },
      {
        artgId: artgIds[1],
        activeIngredient: `${token} ingredient`,
        normalizedIngredient: `${token.toLocaleLowerCase()} ingredient`,
        matchedDrugId: drugId,
        sponsor: "Dashboard boundary fixture",
        registrationDate: threeMonthsAgo,
        productName: `${token} unmatched three month product`,
        status: "REGISTERED",
      },
      {
        artgId: artgIds[2],
        activeIngredient: `${token} ingredient`,
        normalizedIngredient: `${token.toLocaleLowerCase()} ingredient`,
        matchedDrugId: drugId,
        sponsor: "Dashboard boundary fixture",
        registrationDate: twelveMonthsAgo,
        productName: `${token} unmatched twelve month product`,
        status: "REGISTERED",
      },
      {
        artgId: artgIds[3],
        activeIngredient: `${token} ingredient`,
        normalizedIngredient: `${token.toLocaleLowerCase()} ingredient`,
        matchedDrugId: drugId,
        sponsor: "Dashboard boundary fixture",
        registrationDate: scheduleDate,
        productName: `${visibleBrand} 10 mg`,
        status: "REGISTERED",
      },
      {
        artgId: artgIds[4],
        activeIngredient: `${token} ingredient`,
        normalizedIngredient: `${token.toLocaleLowerCase()} ingredient`,
        matchedDrugId: drugId,
        sponsor: "Dashboard boundary fixture",
        registrationDate: scheduleDate,
        productName: `${hiddenBrand} 10 mg`,
        status: "REGISTERED",
      },
      {
        artgId: artgIds[5],
        activeIngredient: `${token} ingredient`,
        normalizedIngredient: `${token.toLocaleLowerCase()} ingredient`,
        matchedDrugId: drugId,
        sponsor: "Dashboard boundary fixture",
        registrationDate: scheduleDate,
        productName: `${token} cancelled product`,
        status: "CANCELLED",
      },
    ]);

    const dashboardResponse = await request(userA, "/dashboard");
    assert.equal(dashboardResponse.status, 200);
    const dashboard = (await dashboardResponse.json()) as {
      periods: Array<{
        key: string;
        available: boolean;
        counts: Record<string, number>;
      }>;
    };
    const period = (key: string) => {
      const value = dashboard.periods.find((entry) => entry.key === key);
      assert.ok(value);
      assert.equal(value.available, true);
      return value;
    };
    const fixtureCounts = (key: string) => {
      const baseline = baselineDashboard.periods.find((entry) => entry.key === key);
      assert.ok(baseline);
      return Object.fromEntries(
        Object.entries(period(key).counts).map(([name, value]) => [name, value - (baseline.counts[name] ?? 0)]),
      );
    };
    assert.deepEqual(fixtureCounts("this_schedule"), {
      newBrands: 1,
      priceReductions: 1,
      delistings: 1,
      formularyChanges: 1,
      amendedListings: 1,
      upcomingReductions: 3,
      artgNotPbsListed: 1,
    });
    assert.deepEqual(fixtureCounts("three_months"), {
      newBrands: 2,
      priceReductions: 1,
      delistings: 1,
      formularyChanges: 1,
      amendedListings: 1,
      upcomingReductions: 2,
      artgNotPbsListed: 2,
    });
    assert.deepEqual(fixtureCounts("twelve_months"), {
      newBrands: 3,
      priceReductions: 1,
      delistings: 2,
      formularyChanges: 1,
      amendedListings: 1,
      upcomingReductions: 3,
      artgNotPbsListed: 3,
    });

    const priceTile = await request(
      userA,
      `/schedule-changes?scheduleCode=${scheduleCode}&changeType=price_change&direction=decrease`,
    );
    assert.equal(priceTile.status, 200);
    const priceChanges = (await priceTile.json()) as Array<{ liItemId: string | null; newValue: { determined_price?: number } }>;
    assert.equal(priceChanges.length, 1);
    assert.equal(priceChanges[0]?.liItemId, `${token}_LI_VISIBLE_PRICE_DOWN`);
    assert.equal(priceChanges[0]?.newValue.determined_price, 90);

    const boundaryTile = await request(
      userA,
      `/schedule-changes?from=${threeMonthsAgo}&to=${threeMonthsAgo}&changeType=new_brand`,
    );
    assert.equal(boundaryTile.status, 200);
    const boundaryChanges = (await boundaryTile.json()) as Array<{ liItemId: string | null }>;
    assert.deepEqual(boundaryChanges.map((change) => change.liItemId), [`${token}_LI_THREE_MONTHS`]);

    const artgTile = await request(
      userA,
      `/artg-entries?from=${threeMonthsAgo}&to=${threeMonthsAgo}&pbs=unlisted`,
    );
    assert.equal(artgTile.status, 200);
    const artgEntries = (await artgTile.json()) as Array<{ artgId: string; pbsListed: boolean }>;
    assert.deepEqual(
      artgEntries.map((entry) => ({ artgId: entry.artgId, pbsListed: entry.pbsListed })),
      [{ artgId: artgIds[1], pbsListed: false }],
    );
  } finally {
    await cleanupFixture(itemCodes, drugIds, artgIds, runIds);
  }
});

test("list, update, and delete operations stay scoped to the signed-in Clerk user", async () => {
  const token = newFixtureToken();
  const itemCode = `${token}_ITEM`;
  const drugId = 2_000_000_000 + (process.pid % 100_000) * 10 + fixtureNumber;
  const fixtureItems = [itemCode];
  const fixtureDrugs = [drugId];

  try {
    await seedItem(itemCode, drugId);
    const ownStockId = await seedStock(userA, itemCode, 2, 10);
    const otherStockId = await seedStock(userB, itemCode, 7, 20);

    const listResponse = await request(userA, "/stock");
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()) as {
      rows: Array<{ id: number; userId: string }>;
    };
    assert.deepEqual(list.rows.map((row: { id: number }) => row.id), [ownStockId]);
    assert.equal(list.rows[0].userId, userA);

    const blockedUpdate = await request(userA, `/stock/${otherStockId}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity: 99 }),
    });
    assert.equal(blockedUpdate.status, 404);
    const allowedUpdate = await request(userB, `/stock/${otherStockId}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity: 8 }),
    });
    assert.equal(allowedUpdate.status, 200);
    assert.equal(((await allowedUpdate.json()) as { quantity: number }).quantity, 8);

    const blockedDelete = await request(userA, `/stock/${otherStockId}`, { method: "DELETE" });
    assert.equal(blockedDelete.status, 404);
    const otherUserList = await request(userB, "/stock");
    assert.equal(otherUserList.status, 200);
    assert.deepEqual(
      ((await otherUserList.json()) as { rows: Array<{ id: number }> }).rows.map((row) => row.id),
      [otherStockId],
    );

    const allowedDelete = await request(userB, `/stock/${otherStockId}`, { method: "DELETE" });
    assert.equal(allowedDelete.status, 204);
    const ownUserListAfterOtherDelete = await request(userA, "/stock");
    assert.deepEqual(
      ((await ownUserListAfterOtherDelete.json()) as { rows: Array<{ id: number }> }).rows.map((row) => row.id),
      [ownStockId],
    );
  } finally {
    await cleanupFixture(fixtureItems, fixtureDrugs);
  }
});

test("exposure reports only positive losses and selects the earliest confirmed prediction", async () => {
  const token = newFixtureToken();
  const itemCodes = ["none", "zero", "negative", "multiple", "precedence"].map((suffix) => `${token}_${suffix}`);
  const drugIds = itemCodes.map((_itemCode, index) => 2_000_000_000 + (process.pid % 100_000) * 10 + fixtureNumber + index + 1);
  const [noPredictionItem, zeroLossItem, negativeLossItem, multiplePredictionItem, precedenceItem] = itemCodes;
  const runIds: number[] = [];

  try {
    const [authorityRun] = await db
      .insert(ingestionRunsTable)
      .values({
        status: "completed",
        recordsProcessed: 0,
        pagesFetched: 0,
        requestUrls: [],
        snapshotComplete: true,
        authorityScope: PRODUCTION_AUTHORITY_SCOPE,
      })
      .returning({ id: ingestionRunsTable.id });
    assert.ok(authorityRun);
    runIds.push(authorityRun.id);
    for (let index = 0; index < itemCodes.length; index += 1) {
      await seedItem(itemCodes[index], drugIds[index]);
    }
    await seedStock(userA, noPredictionItem, 2, 100);
    await seedStock(userA, zeroLossItem, 2, 100);
    await seedStock(userA, negativeLossItem, 2, 100);
    await seedStock(userA, multiplePredictionItem, 3, 100);
    await seedStock(userA, precedenceItem, 2, 100);

    const zeroDate = futureDate(3);
    const negativeDate = futureDate(4);
    const multipleEarlyDate = futureDate(5);
    const multipleLateDate = futureDate(10);
    const precedenceDate = futureDate(6);
    await seedPrediction(zeroLossItem, drugIds[1], zeroDate, 100, "indicative", authorityRun.id);
    await seedPrediction(negativeLossItem, drugIds[2], negativeDate, 120, "indicative", authorityRun.id);
    await seedPrediction(multiplePredictionItem, drugIds[3], multipleEarlyDate, 90, "indicative", authorityRun.id);
    await seedPrediction(multiplePredictionItem, drugIds[3], multipleLateDate, 50, "confirmed", authorityRun.id);
    await seedPrediction(precedenceItem, drugIds[4], precedenceDate, 70, "indicative", authorityRun.id);
    await seedPrediction(precedenceItem, drugIds[4], precedenceDate, 80, "confirmed", authorityRun.id);

    const response = await request(userA, "/stock");
    assert.equal(response.status, 200);
    const exposure = (await response.json()) as {
      rows: Array<{
        itemCode: string;
        prediction: { predictedDate: string; confidence: string } | null;
        perPackExposure: number;
        totalExposure: number;
      }>;
      summary: {
        totalExposure: number;
        totalAtRiskLines: number;
        exposureByDate: Array<{ predictedDate: string; totalExposure: number; lineCount: number }>;
      };
    };
    const rows = new Map(exposure.rows.map((row) => [row.itemCode, row]));
    const rowFor = (itemCode: string) => {
      const row = rows.get(itemCode);
      assert.ok(row);
      return row;
    };
    const noPredictionRow = rowFor(noPredictionItem);
    const zeroLossRow = rowFor(zeroLossItem);
    const negativeLossRow = rowFor(negativeLossItem);
    const multiplePredictionRow = rowFor(multiplePredictionItem);
    const precedenceRow = rowFor(precedenceItem);

    assert.equal(noPredictionRow.prediction, null);
    assert.equal(noPredictionRow.totalExposure, 0);
    assert.equal(zeroLossRow.perPackExposure, 0);
    assert.equal(zeroLossRow.totalExposure, 0);
    assert.equal(negativeLossRow.perPackExposure, 0);
    assert.equal(negativeLossRow.totalExposure, 0);

    assert.ok(multiplePredictionRow.prediction);
    assert.equal(multiplePredictionRow.prediction.predictedDate.slice(0, 10), multipleEarlyDate);
    assert.equal(multiplePredictionRow.perPackExposure, 10);
    assert.equal(multiplePredictionRow.totalExposure, 30);

    assert.ok(precedenceRow.prediction);
    assert.equal(precedenceRow.prediction.confidence, "confirmed");
    assert.equal(precedenceRow.perPackExposure, 20);
    assert.equal(precedenceRow.totalExposure, 40);

    assert.equal(exposure.summary.totalExposure, 70);
    assert.equal(exposure.summary.totalAtRiskLines, 2);
    assert.deepEqual(
      exposure.summary.exposureByDate.map((entry: { predictedDate: string; totalExposure: number; lineCount: number }) => ({
        predictedDate: entry.predictedDate.slice(0, 10),
        totalExposure: entry.totalExposure,
        lineCount: entry.lineCount,
      })),
      [
        { predictedDate: zeroDate, totalExposure: 0, lineCount: 1 },
        { predictedDate: negativeDate, totalExposure: 0, lineCount: 1 },
        { predictedDate: multipleEarlyDate, totalExposure: 30, lineCount: 1 },
        { predictedDate: precedenceDate, totalExposure: 40, lineCount: 1 },
      ],
    );
  } finally {
    await cleanupFixture(itemCodes, drugIds, [], runIds);
  }
});