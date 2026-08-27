import { db } from "@workspace/db";
import {
  drugsTable,
  pbsItemsTable,
  priceHistoryTable,
} from "@workspace/db";

export async function seedReferenceData(): Promise<void> {
  await db
    .insert(drugsTable)
    .values([
      {
        id: 1,
        name: "Rosuvastatin",
        activeIngredient: "Rosuvastatin calcium",
        sponsor: "AstraZeneca Australia",
        firstPbsListingDate: "2007-06-01",
      },
      {
        id: 2,
        name: "Apixaban",
        activeIngredient: "Apixaban",
        sponsor: "Bristol-Myers Squibb Australia",
        firstPbsListingDate: "2013-08-01",
      },
      {
        id: 3,
        name: "Empagliflozin",
        activeIngredient: "Empagliflozin",
        sponsor: "Boehringer Ingelheim",
        firstPbsListingDate: "2014-09-01",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(pbsItemsTable)
    .values([
      {
        itemCode: "1234K",
        liItemId: "seed-1234K",
        drugId: 1,
        brandName: "Crestor",
        formulary: "F1",
        currentAemp: 18.42,
        currentDpmq: 22.31,
        lastUpdated: "2026-07-01",
      },
      {
        itemCode: "5678R",
        liItemId: "seed-5678R",
        drugId: 2,
        brandName: "Eliquis",
        formulary: "F1",
        currentAemp: 34.8,
        currentDpmq: 39.95,
        lastUpdated: "2026-07-01",
      },
      {
        itemCode: "9012W",
        liItemId: "seed-9012W",
        drugId: 3,
        brandName: "Jardiance",
        formulary: "F2",
        currentAemp: 26.15,
        currentDpmq: 30.2,
        lastUpdated: "2026-07-01",
      },
      {
        itemCode: "3456B",
        liItemId: "seed-3456B",
        drugId: 1,
        brandName: "Rosuvastatin Generic",
        formulary: "F2",
        currentAemp: 9.1,
        currentDpmq: 12.75,
        lastUpdated: "2026-07-01",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(priceHistoryTable)
    .values([
      { itemCode: "1234K", priceDate: "2026-07-01", scheduleCode: 0, scheduleEffectiveDate: "2026-07-01", aemp: 18.42, dpmq: 22.31, reductionType: null },
      { itemCode: "1234K", priceDate: "2025-07-01", scheduleCode: 0, scheduleEffectiveDate: "2025-07-01", aemp: 19.15, dpmq: 23.05, reductionType: "PBS price reduction" },
      { itemCode: "5678R", priceDate: "2026-07-01", scheduleCode: 0, scheduleEffectiveDate: "2026-07-01", aemp: 34.8, dpmq: 39.95, reductionType: null },
      { itemCode: "5678R", priceDate: "2025-10-01", scheduleCode: 0, scheduleEffectiveDate: "2025-10-01", aemp: 36.2, dpmq: 41.2, reductionType: "Price disclosure" },
      { itemCode: "9012W", priceDate: "2026-07-01", scheduleCode: 0, scheduleEffectiveDate: "2026-07-01", aemp: 26.15, dpmq: 30.2, reductionType: null },
    ])
    .onConflictDoNothing();
}