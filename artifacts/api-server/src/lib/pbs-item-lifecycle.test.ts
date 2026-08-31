import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  drugsTable,
  pbsItemsTable,
  pool,
  runtimeAuthorityScope,
  withGlobalAuthority,
} from "@workspace/db";
import {
  isCanonicalCurrentSnapshot,
  reconcilePbsItemCatalogueStatus,
} from "./pbs-item-lifecycle";

let fixtureNumber = 0;

function fixture() {
  fixtureNumber += 1;
  const token = `lifecycle_${process.pid}_${fixtureNumber}_${Date.now()}`;
  return {
    token,
    drugId: 1_850_000_000 + (process.pid % 100_000) * 100 + fixtureNumber,
  };
}

function itemValues(itemCode: string, drugId: number) {
  return {
    itemCode,
    pbsCode: `PBS-${itemCode}`,
    liItemId: itemCode,
    scheduleCode: 900_001,
    drugId,
    brandName: `Lifecycle ${itemCode}`,
    strength: "10 mg",
    form: "tablet",
    packSize: "30",
    pricingQuantity: null,
    benefitTypeCode: "S",
    maximumQuantityUnits: 30,
    liForm: "Tablet 10 mg",
    programCode: "GE",
    formulary: "F2" as const,
    currentAemp: 100,
    currentDpmq: null,
    lastUpdated: "2026-01-01",
    firstListedDate: "2020-01-01",
    weightedAvgDisclosedPrice: null,
    originatorBrandIndicator: null,
    brandSubstitutionGroupId: null,
    advancedNoticeDate: null,
    nonEffectiveDate: null,
    determinedPrice: 100,
    claimedPrice: null,
    proportionalPrice: null,
    therapeuticGroupId: null,
    innovatorIndicator: null,
  };
}

test("canonical current snapshots require a valid schedule and non-empty item set", () => {
  assert.equal(isCanonicalCurrentSnapshot({
    scheduleCode: 0,
    effectiveDate: "2026-01-01",
    snapshotItemCodes: new Set(["item"]),
  }), false);
  assert.equal(isCanonicalCurrentSnapshot({
    scheduleCode: 900_001,
    effectiveDate: "2026-01-01",
    snapshotItemCodes: new Set(),
  }), false);
  assert.equal(isCanonicalCurrentSnapshot({
    scheduleCode: 900_001,
    effectiveDate: "2026-01-01",
    snapshotItemCodes: new Set(["item"]),
  }), true);
});

test("reconciliation delists absent items and reactivates genuinely relisted items", async () => {
  const { token, drugId } = fixture();
  const authorityScope = runtimeAuthorityScope();
  const itemCodes = [`${token}_active`, `${token}_delisted`];
  await db.insert(drugsTable).values(withGlobalAuthority({
    id: drugId,
    name: `Lifecycle drug ${token}`,
    activeIngredient: `Lifecycle ingredient ${token}`,
    sponsor: "Lifecycle test sponsor",
    firstPbsListingDate: "2020-01-01",
  }, authorityScope));
  await db.insert(pbsItemsTable).values(itemCodes.map((itemCode) => withGlobalAuthority({
    ...itemValues(itemCode, drugId),
    catalogueStatus: "active" as const,
  }, authorityScope)));

  try {
    const delistResult = await reconcilePbsItemCatalogueStatus({
      authorityScope,
      scheduleCode: 900_001,
      effectiveDate: "2026-02-01",
      snapshotItemCodes: new Set([itemCodes[0]!]),
    });
    assert.deepEqual(delistResult.delistedItemCodes, [itemCodes[1]]);
    assert.deepEqual(delistResult.reactivatedItemCodes, []);
    assert.deepEqual(delistResult.affectedDrugIds, [drugId]);

    const relistResult = await reconcilePbsItemCatalogueStatus({
      authorityScope,
      scheduleCode: 900_002,
      effectiveDate: "2026-03-01",
      snapshotItemCodes: new Set(itemCodes),
    });
    assert.deepEqual(relistResult.delistedItemCodes, []);
    assert.deepEqual(relistResult.reactivatedItemCodes, [itemCodes[1]]);

    const statuses = await db
      .select({
        itemCode: pbsItemsTable.itemCode,
        catalogueStatus: pbsItemsTable.catalogueStatus,
        delistedAt: pbsItemsTable.delistedAt,
        delistedScheduleCode: pbsItemsTable.delistedScheduleCode,
      })
      .from(pbsItemsTable)
      .where(and(
        eq(pbsItemsTable.authorityScope, authorityScope),
        inArray(pbsItemsTable.itemCode, itemCodes),
      ));
    assert.deepEqual(
      statuses.sort((left, right) => left.itemCode.localeCompare(right.itemCode)),
      itemCodes
        .sort()
        .map((itemCode) => ({
          itemCode,
          catalogueStatus: "active" as const,
          delistedAt: null,
          delistedScheduleCode: null,
        })),
    );
  } finally {
    await db.delete(pbsItemsTable).where(inArray(pbsItemsTable.itemCode, itemCodes));
    await db.delete(drugsTable).where(eq(drugsTable.id, drugId));
  }
});

after(async () => {
  await pool.end();
});