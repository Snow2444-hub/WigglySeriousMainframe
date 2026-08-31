import {
  db,
  drugsTable,
  pbsItemsTable,
  priceDisclosureSettingsTable,
  pbsFnbReductionsTable,
  pbsPublishedFilesTable,
  pbsPublishedPricesTable,
  priceHistoryTable,
  predictedReductionsTable,
  reductionSettingsTable,
  scheduleChangesTable,
  ingestionRunsTable,
  runtimeAuthorityScope,
  withDerivedAuthority,
} from "@workspace/db";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { CANONICAL_PUBLISHED_SOURCE_KEYS } from "./pbs-source-status";
import { activePbsItemScope } from "./pbs-item-lifecycle";

const DEFAULT_ANNIVERSARY_SETTINGS = [
  { anniversaryYears: 5, reductionType: "5-year statutory reduction", percentage: 5 },
  { anniversaryYears: 10, reductionType: "10-year statutory reduction", percentage: 5 },
  { anniversaryYears: 15, reductionType: "15-year statutory reduction", percentage: 26.1 },
] as const;

const DEFAULT_FIRST_NEW_BRAND_SETTING = {
  anniversaryYears: 0,
  reductionType: "First New Brand statutory reduction",
  percentage: 25,
  triggerType: "first_new_brand",
  subjectToMinisterialDiscretion: true,
} as const;

const FIRST_NEW_BRAND_ELIGIBILITY_DATE = "2018-10-01";
const FIFTEEN_YEAR_STEP_UP_DATE = "2027-04-01";
const REFERENCE_AEMP_DATE = "2016-01-01";
const SECTION_99ACP_PERCENTAGE = 1.48;
const PUBLISHED_REPORT_MAX_AGE_DAYS = 180;
const LEGACY_WADP_MAX_AGE_DAYS = 90;

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
  for (const setting of DEFAULT_ANNIVERSARY_SETTINGS) {
    await db
      .insert(reductionSettingsTable)
      .values([setting])
      .onConflictDoUpdate({
        target: reductionSettingsTable.anniversaryYears,
        set: {
          reductionType: setting.reductionType,
          percentage: setting.percentage,
          triggerType: "anniversary",
          subjectToMinisterialDiscretion: false,
          updatedAt: new Date(),
        },
      });
  }
  await db.insert(reductionSettingsTable).values([DEFAULT_FIRST_NEW_BRAND_SETTING]).onConflictDoNothing();
  await db
    .insert(priceDisclosureSettingsTable)
    .values([...DEFAULT_PRICE_DISCLOSURE_SETTINGS])
    .onConflictDoNothing();
}

export function actualAnniversaryDate(firstListedDate: string, anniversaryYears: number): string {
  const [year, month, day] = firstListedDate.split("-").map(Number);
  const anniversaryYear = year + anniversaryYears;
  const candidate = new Date(Date.UTC(anniversaryYear, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1) {
    return `${anniversaryYear}-${String(month).padStart(2, "0")}-28`;
  }
  return `${anniversaryYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function roundedForwardToApril(firstListedDate: string, anniversaryYears: number): string {
  const anniversary = actualAnniversaryDate(firstListedDate, anniversaryYears);
  const anniversaryYear = Number(anniversary.slice(0, 4));
  const april = `${anniversaryYear}-04-01`;
  return anniversary <= april ? april : `${anniversaryYear + 1}-04-01`;
}

export function anniversaryRate(anniversaryYears: number, predictedDate: string, configuredPercentage: number): number {
  return anniversaryYears === 15 && predictedDate >= FIFTEEN_YEAR_STEP_UP_DATE
    ? 30
    : configuredPercentage;
}

export function applyReferenceAempCap(
  currentPrice: number,
  proposedPrice: number,
  referenceAemp: number | null,
): { price: number; percentage: number; capped: boolean } | null {
  if (currentPrice <= 0 || !Number.isFinite(currentPrice)) return null;
  if (referenceAemp === null || !Number.isFinite(referenceAemp) || referenceAemp <= 0) return null;
  const cappedPrice = Math.min(currentPrice, Math.max(proposedPrice, referenceAemp * 0.4));
  const price = Number(cappedPrice.toFixed(4));
  return {
    price,
    percentage: Number((((currentPrice - price) / currentPrice) * 100).toFixed(3)),
    capped: price > proposedPrice,
  };
}

export function isFirstNewBrandEligible(effectiveDate: string): boolean {
  return effectiveDate >= FIRST_NEW_BRAND_ELIGIBILITY_DATE;
}

export function calculateFirstNewBrandPrice(
  baselineAemp: number,
  existingEffectivePrice: number | null,
  maximumPercentage = 25,
): { price: number; percentage: number; usesEffectivePrice: boolean } {
  const maximumPrice = baselineAemp * (1 - maximumPercentage / 100);
  const usesEffectivePrice =
    existingEffectivePrice !== null &&
    Number.isFinite(existingEffectivePrice) &&
    existingEffectivePrice > 0 &&
    existingEffectivePrice < baselineAemp;
  const price = Number((usesEffectivePrice ? Math.max(maximumPrice, existingEffectivePrice) : maximumPrice).toFixed(4));
  return {
    price,
    percentage: Number((((baselineAemp - price) / baselineAemp) * 100).toFixed(3)),
    usesEffectivePrice,
  };
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

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export async function recalculatePredictedReductionsForDrug(
  drugId: number,
  today = new Date().toISOString().slice(0, 10),
  authorityRunId?: number,
): Promise<number> {
  await ensureDefaultReductionSettings();
  const authorityScope = runtimeAuthorityScope();
  const [authorityRun] = authorityRunId === undefined
    ? await db
        .select({ id: ingestionRunsTable.id })
        .from(ingestionRunsTable)
        .where(eq(ingestionRunsTable.authorityScope, authorityScope))
        .orderBy(asc(ingestionRunsTable.id))
        .limit(1)
    : [{ id: authorityRunId }];
  if (!authorityRun) {
    throw new Error("Predicted reductions require an authoritative ingestion run.");
  }

  const [drug] = await db.select().from(drugsTable).where(and(eq(drugsTable.id, drugId), eq(drugsTable.authorityScope, authorityScope))).limit(1);
  if (!drug) return 0;

  const items = await db
    .select({
      itemCode: pbsItemsTable.itemCode,
      currentPrice: pbsItemsTable.currentAemp,
      determinedPrice: pbsItemsTable.determinedPrice,
      firstListedDate: pbsItemsTable.firstListedDate,
      lastUpdated: pbsItemsTable.lastUpdated,
      weightedAvgDisclosedPrice: pbsItemsTable.weightedAvgDisclosedPrice,
      formulary: pbsItemsTable.formulary,
    })
    .from(pbsItemsTable)
    .where(and(eq(pbsItemsTable.drugId, drugId), activePbsItemScope(), eq(pbsItemsTable.authorityScope, authorityScope)));
  const settings = await db
    .select()
    .from(reductionSettingsTable)
    .orderBy(asc(reductionSettingsTable.anniversaryYears));
  const disclosureSettings = await db
    .select()
    .from(priceDisclosureSettingsTable)
    .orderBy(asc(priceDisclosureSettingsTable.reductionMonth));

  await db.delete(predictedReductionsTable).where(and(
    eq(predictedReductionsTable.drugId, drugId),
    sql`EXISTS (SELECT 1 FROM ${ingestionRunsTable} WHERE ${ingestionRunsTable.id} = ${predictedReductionsTable.authorityRunId} AND ${ingestionRunsTable.authorityScope} = ${authorityScope})`,
  ));
  if (items.length === 0) return 0;

  const f1Items = items.filter((item) => item.formulary === "F1");
  const priceHistory = await db
    .select({
      itemCode: priceHistoryTable.itemCode,
      scheduleEffectiveDate: priceHistoryTable.scheduleEffectiveDate,
      aemp: priceHistoryTable.aemp,
    })
    .from(priceHistoryTable)
    .where(inArray(priceHistoryTable.itemCode, items.map((item) => item.itemCode)))
    .orderBy(asc(priceHistoryTable.scheduleEffectiveDate), asc(priceHistoryTable.id));
  const referenceAempByItem = new Map<string, { value: number; asOf: string | null }>();
  for (const item of f1Items) {
    const referenceDate = (item.firstListedDate ?? drug.firstPbsListingDate) > REFERENCE_AEMP_DATE
      ? (item.firstListedDate ?? drug.firstPbsListingDate)
      : REFERENCE_AEMP_DATE;
    const historical = [...priceHistory]
      .filter((row) => row.itemCode === item.itemCode && row.scheduleEffectiveDate <= referenceDate)
      .at(-1);
    referenceAempByItem.set(item.itemCode, {
      value: historical?.aemp ?? item.currentPrice,
      asOf: historical ? referenceDate : null,
    });
  }
  const statutoryRows = settings.flatMap((setting) => {
    if (setting.triggerType !== "anniversary") return [];
    const predictedDate = roundedForwardToApril(drug.firstPbsListingDate, setting.anniversaryYears);
    if (predictedDate <= today) return [];
    const rate = anniversaryRate(setting.anniversaryYears, predictedDate, setting.percentage);
    return f1Items.flatMap((item) => {
      const referenceAemp = referenceAempByItem.get(item.itemCode);
      if (!referenceAemp) return [];
      const proposedPrice = Number((item.currentPrice * (1 - rate / 100)).toFixed(4));
      const capped = applyReferenceAempCap(item.currentPrice, proposedPrice, referenceAemp.value);
      if (!capped) return [];
      const referenceLabel = referenceAemp.asOf
        ? `Reference AEMP: ${referenceAemp.value.toFixed(4)} as at ${referenceAemp.asOf}`
        : "Reference-AEMP history is unavailable; current AEMP used for the displayed estimate and the 60% cap is not independently verifiable";
      return [{
        itemCode: item.itemCode,
        drugId,
        predictedDate,
        reductionType: setting.reductionType,
        predictedPercentage: capped.percentage,
        predictedNewPrice: capped.price,
        confidence: referenceAemp.asOf ? "high" : "conditional",
        subjectToMinisterialDiscretion: setting.subjectToMinisterialDiscretion,
        sourceNote: `Configured F1 ${setting.anniversaryYears}-year statutory reduction at ${rate.toFixed(3)}%; applied 1 April. ${referenceLabel}${capped.capped ? "; 60% reference-AEMP cap applied" : ""}.`,
      }];
    });
  });
  const section99AcpDate = actualAnniversaryDate(drug.firstPbsListingDate, 15);
  const section99AcpRows = section99AcpDate > today
    ? f1Items.flatMap((item) => {
        const referenceAemp = referenceAempByItem.get(item.itemCode);
        if (!referenceAemp) return [];
        const proposedPrice = Number((item.currentPrice * (1 - SECTION_99ACP_PERCENTAGE / 100)).toFixed(4));
        const capped = applyReferenceAempCap(item.currentPrice, proposedPrice, referenceAemp.value);
        if (!capped) return [];
        return [{
          itemCode: item.itemCode,
          drugId,
          predictedDate: section99AcpDate,
          reductionType: "section 99ACP 1.48% reduction",
          predictedPercentage: capped.percentage,
          predictedNewPrice: capped.price,
          confidence: referenceAemp.asOf ? "high" : "conditional",
          subjectToMinisterialDiscretion: false,
          sourceNote: `Separate section 99ACP reduction on the actual 15th PBS anniversary date; configured rate ${SECTION_99ACP_PERCENTAGE.toFixed(2)}%${referenceAemp.asOf ? "" : "; reference-AEMP history unavailable, so the 60% cap is not independently verifiable"}${capped.capped ? "; 60% reference-AEMP cap applied" : ""}.`,
        }];
      })
    : [];

  const firstNewBrandSetting = settings.find((setting) => setting.triggerType === "first_new_brand");
  const [firstNewBrandChanges, fnbReductions] = await Promise.all([
    firstNewBrandSetting
      ? db
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
              sql`EXISTS (SELECT 1 FROM ${ingestionRunsTable} WHERE ${ingestionRunsTable.id} = ${scheduleChangesTable.authorityRunId} AND ${ingestionRunsTable.authorityScope} = ${authorityScope})`,
            ),
          )
          .orderBy(asc(scheduleChangesTable.effectiveDate))
          .then((changes) =>
            changes
              .filter((change) => isRecord(change.oldValue))
              .filter((change) => {
                const baselineItems = (change.oldValue as JsonRecord).baseline_items;
                return Array.isArray(baselineItems) && baselineItems.length > 0;
              })
              .filter((change) => isFirstNewBrandEligible(change.effectiveDate)),
          )
      : Promise.resolve([]),
    db
      .select({ effectDate: pbsFnbReductionsTable.effectDate })
      .from(pbsFnbReductionsTable)
      .innerJoin(pbsPublishedFilesTable, eq(pbsFnbReductionsTable.fileId, pbsPublishedFilesTable.id))
      .where(
        and(
          eq(pbsFnbReductionsTable.drugId, drugId),
          lte(pbsFnbReductionsTable.effectDate, today),
          inArray(pbsPublishedFilesTable.sourceKey, CANONICAL_PUBLISHED_SOURCE_KEYS),
        ),
      )
      .orderBy(asc(pbsFnbReductionsTable.effectDate)),
  ]);
  const firstNewBrandChange = firstNewBrandChanges[0];
  const firstNewBrandRows = fnbReductions.length === 0 && firstNewBrandChange && firstNewBrandSetting
    ? (() => {
        const oldValue = isRecord(firstNewBrandChange.oldValue) ? firstNewBrandChange.oldValue : {};
        const baselineItems = Array.isArray(oldValue.baseline_items)
          ? oldValue.baseline_items.filter(isRecord)
          : [];
        const currentItems = new Map(items.map((item) => [item.itemCode, item]));
        return baselineItems.flatMap((baseline) => {
          const itemCode = stringField(baseline, "li_item_id");
          const currentPrice = numberField(baseline, "determined_price");
           const currentItem = itemCode ? currentItems.get(itemCode) : undefined;
           if (!itemCode || currentPrice === undefined || !currentItem) return [];
           const fnbPrice = calculateFirstNewBrandPrice(currentPrice, currentItem.currentPrice, firstNewBrandSetting.percentage);
          return [{
            itemCode,
            drugId,
            predictedDate: firstNewBrandChange.effectiveDate,
            reductionType: firstNewBrandSetting.reductionType,
             predictedPercentage: fnbPrice.percentage,
             predictedNewPrice: fnbPrice.price,
            confidence: "conditional",
            subjectToMinisterialDiscretion: firstNewBrandSetting.subjectToMinisterialDiscretion,
             sourceNote: `Predicted at ${firstNewBrandChange.effectiveDate} from the pre-event AEMP; first-new-brand reduction is up to ${firstNewBrandSetting.percentage.toFixed(3)}% and is subject to Ministerial discretion${fnbPrice.usesEffectivePrice ? `; existing effective price limits this item to ${fnbPrice.percentage.toFixed(3)}%` : ""}.`,
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
        const rawGap = Number(
          (((item.determinedPrice - item.weightedAvgDisclosedPrice) / item.determinedPrice) * 100)
            .toFixed(3),
        );
        const { setting, predictedDate } = nextDisclosureSetting;
        const wadpAsOf = item.lastUpdated;
        const wadpAge = Math.floor(
          (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${wadpAsOf}T00:00:00Z`)) / 86_400_000,
        );
        const maxWadpAgeDays = LEGACY_WADP_MAX_AGE_DAYS;
        const maxWadpReduction = 30;
        const disclosureLeadDays = Math.floor(
          (Date.parse(`${predictedDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
        );
        if (
          rawGap < setting.minimumGapPercentage ||
          wadpAge < 0 ||
          wadpAge > maxWadpAgeDays ||
          disclosureLeadDays > 366
        ) {
          return [];
        }
        const gap = Math.min(rawGap, maxWadpReduction);
        const wadpWasCapped = rawGap > maxWadpReduction;
        return [{
          itemCode: item.itemCode,
          drugId,
          predictedDate,
          reductionType: "price_disclosure",
          predictedPercentage: gap,
          predictedNewPrice: Number((item.determinedPrice * (1 - gap / 100)).toFixed(4)),
          confidence: "indicative",
           subjectToMinisterialDiscretion: false,
          sourceValidUntil: addDays(wadpAsOf, maxWadpAgeDays),
          sourceNote: `Legacy WADP signal from PBS /items, snapshot as of ${wadpAsOf}; indicative only and accepted for at most ${maxWadpAgeDays} days. WADP is ${rawGap.toFixed(3)}% below determined price${wadpWasCapped ? `; displayed estimate bounded at ${maxWadpReduction.toFixed(3)}%` : ""}. Configured minimum is ${setting.minimumGapPercentage.toFixed(3)}%; PBS documentation states a 10% or 30% threshold applies depending on the item.`,
        }];
      })
    : [];
  const publishedPrices = await db
    .select({
      itemCode: pbsPublishedPricesTable.matchedItemCode,
      predictedDate: pbsPublishedPricesTable.predictedDate,
      currentAemp: pbsPublishedPricesTable.currentAemp,
      newAemp: pbsPublishedPricesTable.newAemp,
      confidence: pbsPublishedPricesTable.confidence,
      sourcePriority: pbsPublishedPricesTable.sourcePriority,
      sourceRowNumber: pbsPublishedPricesTable.sourceRowNumber,
      sourceKey: pbsPublishedFilesTable.sourceKey,
      fileId: pbsPublishedFilesTable.id,
      fileStatus: pbsPublishedFilesTable.status,
      parseHealth: pbsPublishedFilesTable.parseHealth,
      reportPublicationDate: pbsPublishedFilesTable.reportPublicationDate,
      retrievedAt: pbsPublishedFilesTable.retrievedAt,
      reportEffectiveDate: pbsPublishedFilesTable.effectiveDate,
    })
    .from(pbsPublishedPricesTable)
    .innerJoin(pbsPublishedFilesTable, eq(pbsPublishedPricesTable.fileId, pbsPublishedFilesTable.id))
    .where(
      and(
        eq(pbsPublishedPricesTable.drugId, drugId),
        eq(pbsPublishedFilesTable.isCurrent, true),
        eq(pbsPublishedFilesTable.status, "completed"),
        inArray(pbsPublishedFilesTable.sourceKey, CANONICAL_PUBLISHED_SOURCE_KEYS),
      ),
    );
  const freshPublishedPrices = publishedPrices.filter((price) => {
    if (price.parseHealth !== "healthy") return false;
    const asOf = price.reportPublicationDate ?? price.retrievedAt.toISOString().slice(0, 10);
    const age = Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000,
    );
    return (
      age >= 0 &&
      age <= 180 &&
      (!price.reportEffectiveDate || price.reportEffectiveDate === price.predictedDate)
    );
  });
  const publishedPriceByItemDate = new Map<string, typeof freshPublishedPrices[number]>();
  for (const price of freshPublishedPrices) {
    const key = `${price.itemCode}:${price.predictedDate}`;
    const existing = publishedPriceByItemDate.get(key);
    const rank = price.sourcePriority || (price.confidence === "confirmed" ? 2 : 1);
    const existingRank = existing
      ? existing.sourcePriority || (existing.confidence === "confirmed" ? 2 : 1)
      : -1;
    if (
      !existing ||
      rank > existingRank ||
      (rank === existingRank && price.retrievedAt > existing.retrievedAt)
    ) {
      publishedPriceByItemDate.set(key, price);
    }
  }
  const publishedRows = [...publishedPriceByItemDate.values()].flatMap((price) => {
    if (price.currentAemp <= 0) return [];
    const percentage = Number(
      (((price.currentAemp - price.newAemp) / price.currentAemp) * 100).toFixed(3),
    );
    return [{
      itemCode: price.itemCode,
      drugId,
      predictedDate: price.predictedDate,
      reductionType: "price_disclosure",
      predictedPercentage: percentage,
      predictedNewPrice: price.newAemp,
      confidence: price.confidence,
      subjectToMinisterialDiscretion: false,
       sourceValidUntil: addDays(
         price.reportPublicationDate ?? price.retrievedAt.toISOString().slice(0, 10),
         PUBLISHED_REPORT_MAX_AGE_DAYS,
       ),
       sourceFileId: price.fileId,
       sourceRowNumber: price.sourceRowNumber,
       sourceNote: `${price.confidence === "confirmed" ? "Confirmed" : "Indicative"} Prices Report (${price.sourceKey}), file observation ${price.fileId}, source row ${price.sourceRowNumber}; ${price.confidence === "confirmed" ? "supersedes indicative evidence." : "will be superseded when confirmed prices are published."}`,
    }];
  });
  const publishedKeys = new Set(publishedRows.map((row) => `${row.itemCode}:${row.predictedDate}`));
  const filteredDisclosureRows = disclosureRows.filter(
    (row) => !publishedKeys.has(`${row.itemCode}:${row.predictedDate}`),
  );
  const rows = [...statutoryRows, ...section99AcpRows, ...firstNewBrandRows, ...filteredDisclosureRows, ...publishedRows];

  if (rows.length > 0) {
    await db
      .insert(predictedReductionsTable)
      .values(rows.map((row) => withDerivedAuthority(authorityRun.id, row)));
  }
  return rows.length;
}

export async function recalculatePredictedReductionsForAllDrugs(
  today = new Date().toISOString().slice(0, 10),
  authorityRunId?: number,
): Promise<number> {
  const drugs = await db.select({ id: drugsTable.id }).from(drugsTable).where(eq(drugsTable.authorityScope, runtimeAuthorityScope())).orderBy(asc(drugsTable.id));
  let total = 0;
  for (const drug of drugs) {
    total += await recalculatePredictedReductionsForDrug(drug.id, today, authorityRunId);
  }
  return total;
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