import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { inArray } from "drizzle-orm";
import { db, drugsTable, pharmacyStockTable, pbsItemsTable, pool, predictedReductionsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { createStockRouter } from "./stock";

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
  });
}

async function cleanupFixture(itemCodes: string[], drugIds: number[]) {
  await db.delete(predictedReductionsTable).where(inArray(predictedReductionsTable.itemCode, itemCodes));
  await db.delete(pharmacyStockTable).where(inArray(pharmacyStockTable.itemCode, itemCodes));
  await db.delete(pbsItemsTable).where(inArray(pbsItemsTable.itemCode, itemCodes));
  await db.delete(drugsTable).where(inArray(drugsTable.id, drugIds));
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

  try {
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
    await seedPrediction(zeroLossItem, drugIds[1], zeroDate, 100, "indicative");
    await seedPrediction(negativeLossItem, drugIds[2], negativeDate, 120, "indicative");
    await seedPrediction(multiplePredictionItem, drugIds[3], multipleEarlyDate, 90, "indicative");
    await seedPrediction(multiplePredictionItem, drugIds[3], multipleLateDate, 50, "confirmed");
    await seedPrediction(precedenceItem, drugIds[4], precedenceDate, 70, "indicative");
    await seedPrediction(precedenceItem, drugIds[4], precedenceDate, 80, "confirmed");

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
    await cleanupFixture(itemCodes, drugIds);
  }
});