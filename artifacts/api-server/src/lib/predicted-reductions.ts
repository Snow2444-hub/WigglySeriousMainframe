import {
  db,
  drugsTable,
  pbsItemsTable,
  priceDisclosureSettingsTable,
  predictedReductionsTable,
  reductionSettingsTable,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";

const DEFAULT_SETTINGS = [
  { anniversaryYears: 5, reductionType: "5-year statutory reduction", percentage: 5 },
  { anniversaryYears: 10, reductionType: "10-year statutory reduction", percentage: 5 },
  { anniversaryYears: 15, reductionType: "15-year statutory reduction", percentage: 26.1 },
] as const;

const DEFAULT_PRICE_DISCLOSURE_SETTINGS = [
  {
    settingKey: "price-disclosure-april",
    reductionMonth: 4,
    reductionDay: 1,
    minimumGapPercentage: 10,
    highConfidenceGapPercentage: 30,
  },
  {
    settingKey: "price-disclosure-october",
    reductionMonth: 10,
    reductionDay: 1,
    minimumGapPercentage: 10,
    highConfidenceGapPercentage: 30,
  },
] as const;

export async function ensureDefaultReductionSettings(): Promise<void> {
  await db.insert(reductionSettingsTable).values([...DEFAULT_SETTINGS]).onConflictDoNothing();
  await db
    .insert(priceDisclosureSettingsTable)
    .values([...DEFAULT_PRICE_DISCLOSURE_SETTINGS])
    .onConflictDoNothing();
}

function roundedForwardToApril(firstListedDate: string, anniversaryYears: number): string {
  const [year, month, day] = firstListedDate.split("-").map(Number);
  const anniversaryYear = year + anniversaryYears;
  const anniversary = `${anniversaryYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const april = `${anniversaryYear}-04-01`;
  return anniversary <= april ? april : `${anniversaryYear + 1}-04-01`;
}

function calculateNewPrice(currentPrice: number, percentage: number): number {
  return Number((currentPrice * (1 - percentage / 100)).toFixed(4));
}

function configuredReductionDate(
  today: string,
  month: number,
  day: number,
): string {
  const year = Number(today.slice(0, 4));
  const dateInYear = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return dateInYear > today
    ? dateInYear
    : `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export async function recalculatePredictedReductionsForDrug(
  drugId: number,
  today = new Date().toISOString().slice(0, 10),
): Promise<number> {
  await ensureDefaultReductionSettings();

  const [drug] = await db.select().from(drugsTable).where(eq(drugsTable.id, drugId)).limit(1);
  if (!drug) return 0;

  const items = await db
    .select({
      itemCode: pbsItemsTable.itemCode,
      currentPrice: pbsItemsTable.currentAemp,
      determinedPrice: pbsItemsTable.determinedPrice,
      weightedAvgDisclosedPrice: pbsItemsTable.weightedAvgDisclosedPrice,
      formulary: pbsItemsTable.formulary,
    })
    .from(pbsItemsTable)
    .where(eq(pbsItemsTable.drugId, drugId));
  const settings = await db
    .select()
    .from(reductionSettingsTable)
    .orderBy(asc(reductionSettingsTable.anniversaryYears));
  const disclosureSettings = await db
    .select()
    .from(priceDisclosureSettingsTable)
    .orderBy(asc(priceDisclosureSettingsTable.reductionMonth));

  await db.delete(predictedReductionsTable).where(eq(predictedReductionsTable.drugId, drugId));
  if (items.length === 0) return 0;

  const f1Items = items.filter((item) => item.formulary === "F1");
  const statutoryRows = settings.flatMap((setting) => {
    const predictedDate = roundedForwardToApril(drug.firstPbsListingDate, setting.anniversaryYears);
    if (predictedDate <= today) return [];
    return f1Items.map((item) => ({
      itemCode: item.itemCode,
      drugId,
      predictedDate,
      reductionType: setting.reductionType,
      predictedPercentage: setting.percentage,
      predictedNewPrice: calculateNewPrice(item.currentPrice, setting.percentage),
      confidence: "high",
      sourceNote: `Configured F1 statutory reduction at ${setting.anniversaryYears} years from first PBS listing; anniversary rounded forward to 1 April`,
    }));
  });

  const nextDisclosureSetting = disclosureSettings
    .map((setting) => ({
      setting,
      predictedDate: configuredReductionDate(today, setting.reductionMonth, setting.reductionDay),
    }))
    .sort((left, right) => left.predictedDate.localeCompare(right.predictedDate))[0];

  const disclosureRows = nextDisclosureSetting
    ? items.flatMap((item) => {
        if (
          item.formulary !== "F2" ||
          item.determinedPrice === null ||
          item.weightedAvgDisclosedPrice === null ||
          item.determinedPrice <= 0 ||
          item.weightedAvgDisclosedPrice >= item.determinedPrice
        ) {
          return [];
        }
        const gap = Number(
          (((item.determinedPrice - item.weightedAvgDisclosedPrice) / item.determinedPrice) * 100)
            .toFixed(3),
        );
        const { setting, predictedDate } = nextDisclosureSetting;
        if (gap < setting.minimumGapPercentage) {
          return [];
        }
        const confidence = gap >= setting.highConfidenceGapPercentage ? "high" : "conditional";
        return [{
          itemCode: item.itemCode,
          drugId,
          predictedDate,
          reductionType: "price_disclosure",
          predictedPercentage: gap,
          predictedNewPrice: item.weightedAvgDisclosedPrice,
          confidence,
          sourceNote: `WADP is ${gap.toFixed(3)}% below determined price; configured minimum is ${setting.minimumGapPercentage.toFixed(3)}%, while PBS documentation states a 10% or 30% threshold applies depending on the item`,
        }];
      })
    : [];
  const rows = [...statutoryRows, ...disclosureRows];

  if (rows.length > 0) {
    await db.insert(predictedReductionsTable).values(rows);
  }
  return rows.length;
}