import {
  db,
  drugsTable,
  pbsItemsTable,
  priceDisclosureSettingsTable,
  predictedReductionsTable,
  reductionSettingsTable,
  scheduleChangesTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

const DEFAULT_SETTINGS = [
  { anniversaryYears: 5, reductionType: "5-year statutory reduction", percentage: 5 },
  { anniversaryYears: 10, reductionType: "10-year statutory reduction", percentage: 5 },
  { anniversaryYears: 15, reductionType: "15-year statutory reduction", percentage: 26.1 },
  {
    anniversaryYears: 0,
    reductionType: "First New Brand statutory reduction",
    percentage: 25,
    triggerType: "first_new_brand",
    subjectToMinisterialDiscretion: true,
  },
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
    if (setting.triggerType !== "anniversary") return [];
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
       subjectToMinisterialDiscretion: setting.subjectToMinisterialDiscretion,
      sourceNote: `Configured F1 statutory reduction at ${setting.anniversaryYears} years from first PBS listing; anniversary rounded forward to 1 April`,
    }));
  });

  const firstNewBrandSetting = settings.find((setting) => setting.triggerType === "first_new_brand");
  const firstNewBrandChanges = firstNewBrandSetting
    ? await db
        .select({
          effectiveDate: scheduleChangesTable.effectiveDate,
          oldValue: scheduleChangesTable.oldValue,
        })
        .from(scheduleChangesTable)
        .where(
          and(
            eq(scheduleChangesTable.drugId, drugId),
            eq(scheduleChangesTable.changeType, "new_brand"),
            eq(scheduleChangesTable.significance, "high"),
          ),
        )
        .orderBy(asc(scheduleChangesTable.effectiveDate))
        .then((changes) =>
          changes
            .filter((change) => isRecord(change.oldValue))
            .filter((change) => {
              const baselineItems = (change.oldValue as JsonRecord).baseline_items;
              return Array.isArray(baselineItems) && baselineItems.length > 0;
            }),
        )
    : [];
  const firstNewBrandChange = firstNewBrandChanges[0];
  const firstNewBrandRows = firstNewBrandChange && firstNewBrandSetting
    ? (() => {
        const oldValue = isRecord(firstNewBrandChange.oldValue) ? firstNewBrandChange.oldValue : {};
        const baselineItems = Array.isArray(oldValue.baseline_items)
          ? oldValue.baseline_items.filter(isRecord)
          : [];
        const currentItems = new Map(items.map((item) => [item.itemCode, item]));
        return baselineItems.flatMap((baseline) => {
          const itemCode = stringField(baseline, "li_item_id");
          const currentPrice = numberField(baseline, "determined_price");
          if (!itemCode || currentPrice === undefined || !currentItems.has(itemCode)) return [];
          return [{
            itemCode,
            drugId,
            predictedDate: firstNewBrandChange.effectiveDate,
            reductionType: firstNewBrandSetting.reductionType,
            predictedPercentage: firstNewBrandSetting.percentage,
            predictedNewPrice: calculateNewPrice(currentPrice, firstNewBrandSetting.percentage),
            confidence: "conditional",
            subjectToMinisterialDiscretion: firstNewBrandSetting.subjectToMinisterialDiscretion,
            sourceNote: `Predicted at ${firstNewBrandChange.effectiveDate} from the pre-event current AEMP; first-new-brand statutory reduction is subject to Ministerial discretion.`,
          }];
        });
      })()
    : [];

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
           subjectToMinisterialDiscretion: false,
          sourceNote: `WADP is ${gap.toFixed(3)}% below determined price; configured minimum is ${setting.minimumGapPercentage.toFixed(3)}%, while PBS documentation states a 10% or 30% threshold applies depending on the item`,
        }];
      })
    : [];
  const rows = [...statutoryRows, ...firstNewBrandRows, ...disclosureRows];

  if (rows.length > 0) {
    await db.insert(predictedReductionsTable).values(rows);
  }
  return rows.length;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numberField(record: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}