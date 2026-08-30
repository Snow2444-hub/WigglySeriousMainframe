import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lte, not, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  artgEntriesTable,
  artgIngestionRunsTable,
  drugsTable,
  pbsItemPremiumHistoryTable,
  pbsDisclosureCyclesTable,
  pbsFnbReductionsTable,
  pbsItemsTable,
  pbsPublishedFileRowsTable,
  pbsPublishedFilesTable,
  predictedReductionsTable,
  priceHistoryTable,
  scheduleChangesTable,
} from "@workspace/db";
import { CANONICAL_PUBLISHED_SOURCE_KEYS } from "../lib/pbs-source-status";
import type { ScheduleChangeAffectedItem } from "@workspace/db";
import {
  GetDrugScheduleTimelineParams,
  GetDrugScheduleTimelineResponse,
  GetDrugParams,
  GetDrugResponse,
  GetArtgImportStatusResponse,
  GetPbsItemParams,
  GetPbsItemResponse,
  ListArtgEntriesQueryParams,
  ListArtgEntriesResponse,
  ListDrugsQueryParams,
  ListDrugsResponse,
  ListPbsItemsQueryParams,
  ListPbsItemsResponse,
  ListMedicineBrandItemsParams,
  ListMedicineBrandItemsResponse,
  ListMedicineBrandsParams,
  ListMedicineBrandsResponse,
  ListMedicineDirectoryQueryParams,
  ListMedicineDirectoryResponse,
  ListUpcomingPredictedReductionsQueryParams,
  ListUpcomingPredictedReductionsResponse,
  ListAnniversaryVerificationResponse,
  ListItemPredictedReductionsParams,
  ListItemPredictedReductionsResponse,
  ListItemPremiumHistoryParams,
  ListItemPremiumHistoryResponse,
  ListItemScheduleChangesParams,
  ListItemScheduleChangesResponse,
  ListPriceHistoryParams,
  ListPriceHistoryResponse,
  ListScheduleChangesQueryParams,
  ListScheduleChangesResponse,
} from "@workspace/api-zod";
import { getPriceChangeThresholds, priceChangeSignificance } from "../lib/schedule-changes";
import { getHiddenBrandKeys, isBrandHidden } from "../lib/brand-preferences";
import { pbsBrandMatchesArtgProduct } from "../lib/artg-import";
import {
  buildAnniversaryVerification,
  type AnniversaryCatalogueItem,
  type AnniversaryPrediction,
  type AnniversaryPublishedRow,
} from "../lib/anniversary-verification";
import { isPublishedReportFresh } from "../lib/pbs-published-files";
import { requireAuth } from "../middlewares/requireAuth";

export function createReferenceRouter(
  database: typeof db = db,
  authMiddleware: typeof requireAuth = requireAuth,
): IRouter {
  const router: IRouter = Router();
  const db = database;

  router.use(authMiddleware);

router.get("/drugs", async (req, res): Promise<void> => {
  const parsed = ListDrugsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, limit = 50 } = parsed.data;
  const rows = await db
    .select()
    .from(drugsTable)
    .where(
      search
        ? or(
            ilike(drugsTable.name, `%${search}%`),
            ilike(drugsTable.activeIngredient, `%${search}%`),
            ilike(drugsTable.sponsor, `%${search}%`),
          )
        : undefined,
    )
    .orderBy(asc(drugsTable.name))
    .limit(limit);
  res.json(ListDrugsResponse.parse(rows));
});

router.get("/drugs/:id", async (req, res): Promise<void> => {
  const parsed = GetDrugParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.select().from(drugsTable).where(eq(drugsTable.id, parsed.data.id));
  if (!row) {
    res.status(404).json({ error: "Drug not found" });
    return;
  }
  res.json(GetDrugResponse.parse(row));
});

const pbsSelect = {
  itemCode: pbsItemsTable.itemCode,
  pbsCode: pbsItemsTable.pbsCode,
  liItemId: pbsItemsTable.liItemId,
  scheduleCode: pbsItemsTable.scheduleCode,
  drugId: pbsItemsTable.drugId,
  brandName: pbsItemsTable.brandName,
  strength: pbsItemsTable.strength,
  form: pbsItemsTable.form,
  packSize: pbsItemsTable.packSize,
  pricingQuantity: pbsItemsTable.pricingQuantity,
  benefitTypeCode: pbsItemsTable.benefitTypeCode,
  maximumQuantityUnits: pbsItemsTable.maximumQuantityUnits,
  liForm: pbsItemsTable.liForm,
  programCode: pbsItemsTable.programCode,
  formulary: pbsItemsTable.formulary,
  currentAemp: pbsItemsTable.currentAemp,
  currentDpmq: pbsItemsTable.currentDpmq,
  lastUpdated: pbsItemsTable.lastUpdated,
  firstListedDate: pbsItemsTable.firstListedDate,
  weightedAvgDisclosedPrice: pbsItemsTable.weightedAvgDisclosedPrice,
  originatorBrandIndicator: pbsItemsTable.originatorBrandIndicator,
  brandSubstitutionGroupId: pbsItemsTable.brandSubstitutionGroupId,
  advancedNoticeDate: pbsItemsTable.advancedNoticeDate,
  nonEffectiveDate: pbsItemsTable.nonEffectiveDate,
  determinedPrice: pbsItemsTable.determinedPrice,
  claimedPrice: pbsItemsTable.claimedPrice,
  proportionalPrice: pbsItemsTable.proportionalPrice,
  therapeuticGroupId: pbsItemsTable.therapeuticGroupId,
  innovatorIndicator: pbsItemsTable.innovatorIndicator,
  drugName: drugsTable.name,
  activeIngredient: drugsTable.activeIngredient,
  sponsor: drugsTable.sponsor,
};

async function enrichPbsItemRows<T extends { drugId: number }>(rows: T[]): Promise<Array<T & { originatorBrandName: string | null }>> {
  const drugIds = [...new Set(rows.map((row) => row.drugId))];
  if (!drugIds.length) return rows.map((row) => ({ ...row, originatorBrandName: null }));
  const originatorItems = await db
    .select({
      drugId: pbsItemsTable.drugId,
      brandName: pbsItemsTable.brandName,
      innovatorIndicator: pbsItemsTable.innovatorIndicator,
    })
    .from(pbsItemsTable)
    .where(inArray(pbsItemsTable.drugId, drugIds));
  const originatorBrandByDrug = new Map<number, string>();
  for (const item of originatorItems) {
    if (indicatorIsTrue(item.innovatorIndicator) && !originatorBrandByDrug.has(item.drugId)) {
      originatorBrandByDrug.set(item.drugId, item.brandName);
    }
  }
  return rows.map((row) => ({
    ...row,
    originatorBrandName: originatorBrandByDrug.get(row.drugId) ?? null,
  }));
}

function summarizedFormulary(values: Array<string | null>): string {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
  return unique.length > 0 ? unique.join(" / ") : "Not specified";
}

function priceRange(values: Array<number | null>): { minimumPrice: number; maximumPrice: number } {
  const prices = values.filter((value): value is number => value !== null);
  return {
    minimumPrice: prices.length > 0 ? Math.min(...prices) : 0,
    maximumPrice: prices.length > 0 ? Math.max(...prices) : 0,
  };
}

function indicatorIsTrue(value: string | null): boolean {
  if (!value) return false;
  return !["n", "no", "false", "0"].includes(value.trim().toLowerCase());
}

function brandGroupKey(brandName: string): string {
  const normalized = brandName.trim().toLocaleLowerCase();
  if (/^crosuva(?:\s+(5|10|20|40))?$/.test(normalized)) return "crosuva";
  if (/^pharmacor\s+rosuvastatin\s+(5|10|20|40)$/.test(normalized)) return "pharmacor rosuvastatin";
  return normalized;
}

function brandGroupName(brandName: string): string {
  const key = brandGroupKey(brandName);
  if (key === "crosuva") return "Crosuva";
  if (key === "pharmacor rosuvastatin") return "Pharmacor Rosuvastatin";
  return brandName;
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function queryDateOnly(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function parseDateQueryValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return new Date(`${value}T00:00:00Z`);
}

function jsonNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isPriceReduction(change: { oldValue: unknown; newValue: unknown }): boolean {
  const oldPrice = jsonNumber(
    typeof change.oldValue === "object" && change.oldValue !== null
      ? (change.oldValue as Record<string, unknown>).determined_price
      : undefined,
  );
  const newPrice = jsonNumber(
    typeof change.newValue === "object" && change.newValue !== null
      ? (change.newValue as Record<string, unknown>).determined_price
      : undefined,
  );
  return oldPrice !== null && newPrice !== null && newPrice < oldPrice;
}

function strengthSortValue(strength: string | null): number {
  const value = strength?.match(/\d+(?:\.\d+)?/)?.[0];
  return value ? Number(value) : Number.POSITIVE_INFINITY;
}

function nextPrediction<T extends { predictedDate: string; predictedPercentage: number }>(predictions: T[]): T | null {
  return (
    [...predictions].sort(
      (left, right) =>
        left.predictedDate.localeCompare(right.predictedDate) ||
        Math.abs(right.predictedPercentage) - Math.abs(left.predictedPercentage),
    )[0] ?? null
  );
}

function predictedReductionSignificance(
  predictedPercentage: number,
  thresholds: Awaited<ReturnType<typeof getPriceChangeThresholds>>,
): "normal" | "medium" | "high" {
  return priceChangeSignificance(-Math.abs(predictedPercentage), thresholds);
}

function freshPredictionCondition(asOf: string) {
  return or(
    and(
      isNull(predictedReductionsTable.sourceValidUntil),
      not(eq(predictedReductionsTable.reductionType, "price_disclosure")),
    ),
    gte(predictedReductionsTable.sourceValidUntil, asOf),
  );
}

router.get("/medicine-directory", async (req, res): Promise<void> => {
  const parsed = ListMedicineDirectoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const recentDate = new Date();
  recentDate.setUTCDate(recentDate.getUTCDate() - 90);
  const recentDateString = recentDate.toISOString().slice(0, 10);
  const [items, predictions, highChanges, disclosureCycles, fnbReductions, thresholds] = await Promise.all([
    db.select(pbsSelect).from(pbsItemsTable).innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id)),
    db
      .select({
        drugId: predictedReductionsTable.drugId,
        predictedDate: predictedReductionsTable.predictedDate,
        reductionType: predictedReductionsTable.reductionType,
        predictedPercentage: predictedReductionsTable.predictedPercentage,
        confidence: predictedReductionsTable.confidence,
        subjectToMinisterialDiscretion: predictedReductionsTable.subjectToMinisterialDiscretion,
      })
      .from(predictedReductionsTable)
      .where(and(gte(predictedReductionsTable.predictedDate, today), freshPredictionCondition(today))),
    db
      .select({ drugId: scheduleChangesTable.drugId })
      .from(scheduleChangesTable)
      .where(
        and(
          eq(scheduleChangesTable.significance, "high"),
          gte(scheduleChangesTable.effectiveDate, recentDateString),
        ),
      ),
    db
      .select({
        drugId: pbsDisclosureCyclesTable.drugId,
        cycleLabel: pbsDisclosureCyclesTable.cycleLabel,
        submissionDeadline: pbsDisclosureCyclesTable.submissionDeadline,
      })
      .from(pbsDisclosureCyclesTable)
      .innerJoin(pbsPublishedFilesTable, eq(pbsDisclosureCyclesTable.fileId, pbsPublishedFilesTable.id))
      .where(inArray(pbsPublishedFilesTable.sourceKey, CANONICAL_PUBLISHED_SOURCE_KEYS)),
    db
      .select({
        drugId: pbsFnbReductionsTable.drugId,
        effectDate: pbsFnbReductionsTable.effectDate,
      })
      .from(pbsFnbReductionsTable)
      .innerJoin(pbsPublishedFilesTable, eq(pbsFnbReductionsTable.fileId, pbsPublishedFilesTable.id))
      .where(inArray(pbsPublishedFilesTable.sourceKey, CANONICAL_PUBLISHED_SOURCE_KEYS)),
    getPriceChangeThresholds(),
  ]);
  const hiddenBrandKeys = await getHiddenBrandKeys(req.userId as string);
  const visibleItems = items.filter((item) => !isBrandHidden(hiddenBrandKeys, item.drugId, item.brandName));
  const cyclesByDrug = new Map<number, Array<{ cycleLabel: string; submissionDeadline: string }>>();
  for (const cycle of disclosureCycles) {
    cyclesByDrug.set(cycle.drugId, [
      ...(cyclesByDrug.get(cycle.drugId) ?? []),
      { cycleLabel: cycle.cycleLabel, submissionDeadline: dateOnly(cycle.submissionDeadline) },
    ]);
  }
  const fnbByDrug = new Map<number, string>();
  for (const reduction of fnbReductions) {
    const current = fnbByDrug.get(reduction.drugId);
    const effectDate = dateOnly(reduction.effectDate);
    if (!current || effectDate > current) fnbByDrug.set(reduction.drugId, effectDate);
  }
  const grouped = new Map<number, typeof items>();
  for (const item of visibleItems) {
    const group = grouped.get(item.drugId) ?? [];
    group.push(item);
    grouped.set(item.drugId, group);
  }
  const search = parsed.data.search?.trim().toLowerCase();
  const summaries = [...grouped.entries()].flatMap(([drugId, group]) => {
    const first = group[0];
    const originatorBrandName = group.find((item) => indicatorIsTrue(item.innovatorIndicator))?.brandName ?? null;
    const drugMatch = Boolean(
      search &&
        (first.drugName.toLowerCase().includes(search) ||
          first.activeIngredient.toLowerCase().includes(search)),
    );
    const brandMatch = search
      ? group.find((item) => item.brandName.toLowerCase().includes(search))
      : undefined;
    const itemMatch = search
      ? group.find((item) =>
          [item.itemCode, item.pbsCode, item.liItemId].some((value) =>
            value?.toLowerCase().includes(search),
          ),
        )
      : undefined;
    if (search && !drugMatch && !brandMatch && !itemMatch) return [];
    const upcoming = predictions
      .filter((prediction) => prediction.drugId === drugId)
      .sort((a, b) => a.predictedDate.localeCompare(b.predictedDate));
    return [
      {
        drugId,
        drugName: first.drugName,
         originatorBrandName,
        activeIngredient: first.activeIngredient,
        brandCount: new Set(group.map((item) => brandGroupKey(item.brandName))).size,
        itemCount: group.length,
        formulary: summarizedFormulary(group.map((item) => item.formulary)),
        ...priceRange(group.map((item) => item.currentAemp)),
        upcomingPredictedReductionCount: upcoming.length,
        nextPredictedReductionDate: upcoming[0]?.predictedDate ?? null,
         nextPredictedReductionType: upcoming[0]?.reductionType ?? null,
         nextPredictedReductionPercentage: upcoming[0]?.predictedPercentage ?? null,
         nextPredictedReductionConfidence: upcoming[0]?.confidence ?? null,
         nextPredictedReductionSignificance: upcoming[0]
           ? predictedReductionSignificance(upcoming[0].predictedPercentage, thresholds)
           : null,
        recentHighChangeCount: highChanges.filter((change) => change.drugId === drugId).length,
         subjectToPriceDisclosure: (cyclesByDrug.get(drugId) ?? []).length > 0,
         priceDisclosureCycles: cyclesByDrug.get(drugId) ?? [],
         hasTakenFirstNewBrandReduction: fnbByDrug.has(drugId),
         firstNewBrandReductionDate: fnbByDrug.get(drugId) ?? null,
        searchMatchLevel: search ? (drugMatch ? "drug" : brandMatch ? "brand" : "item") : null,
        matchedBrandName: drugMatch ? null : (brandMatch?.brandName ?? itemMatch?.brandName ?? null),
        matchedItemCode: drugMatch || brandMatch ? null : (itemMatch?.itemCode ?? null),
      },
    ];
  });
  summaries.sort((a, b) => a.drugName.localeCompare(b.drugName));
  res.json(ListMedicineDirectoryResponse.parse(summaries));
});

router.get("/medicine-drugs/:id/brands", async (req, res): Promise<void> => {
  const parsed = ListMedicineBrandsParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const [items, changes, predictions, thresholds] = await Promise.all([
    db
      .select(pbsSelect)
      .from(pbsItemsTable)
      .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
      .where(eq(pbsItemsTable.drugId, parsed.data.id)),
    db
      .select({
        brandName: scheduleChangesTable.brandName,
        significance: scheduleChangesTable.significance,
        effectiveDate: scheduleChangesTable.effectiveDate,
      })
      .from(scheduleChangesTable)
      .where(eq(scheduleChangesTable.drugId, parsed.data.id)),
    db
      .select({
        itemCode: predictedReductionsTable.itemCode,
        predictedDate: predictedReductionsTable.predictedDate,
        predictedPercentage: predictedReductionsTable.predictedPercentage,
        predictedNewPrice: predictedReductionsTable.predictedNewPrice,
        confidence: predictedReductionsTable.confidence,
      })
      .from(predictedReductionsTable)
      .where(
        and(
          eq(predictedReductionsTable.drugId, parsed.data.id),
          gte(predictedReductionsTable.predictedDate, today),
          freshPredictionCondition(today),
        ),
      ),
    getPriceChangeThresholds(),
  ]);
  const hiddenBrandKeys = await getHiddenBrandKeys(req.userId as string);
  const visibleItems = items.filter((item) => !isBrandHidden(hiddenBrandKeys, item.drugId, item.brandName));
  const grouped = new Map<string, typeof items>();
  for (const item of visibleItems) {
    const key = brandGroupKey(item.brandName);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  const summaries = [...grouped.values()].map((group) => {
    const first = group[0];
    const brandChanges = changes.filter(
      (change) => change.brandName !== null && brandGroupKey(change.brandName) === brandGroupKey(first.brandName),
    );
    const listedDates = group
      .map((item) => item.firstListedDate)
      .filter((date): date is string => date !== null)
      .sort();
    const changeDates = brandChanges.map((change) => change.effectiveDate).sort();
    const itemsByCode = new Map(group.map((item) => [item.itemCode, item]));
    const prediction = nextPrediction(
      predictions.filter((candidate) => {
        const item = itemsByCode.get(candidate.itemCode);
        return item && brandGroupKey(item.brandName) === brandGroupKey(first.brandName);
      }),
    );
    const predictedItem = prediction ? itemsByCode.get(prediction.itemCode) : undefined;
    return {
      drugId: parsed.data.id,
      brandName: brandGroupName(first.brandName),
      itemCount: group.length,
      formulary: summarizedFormulary(group.map((item) => item.formulary)),
      ...priceRange(group.map((item) => item.currentAemp)),
      isInnovator: group.some(
        (item) =>
          indicatorIsTrue(item.innovatorIndicator) ||
          indicatorIsTrue(item.originatorBrandIndicator),
      ),
      firstListedDate: listedDates[0] ?? null,
      changeCount: brandChanges.length,
      highChangeCount: brandChanges.filter((change) => change.significance === "high").length,
      latestChangeDate: changeDates.at(-1) ?? null,
      nextPredictedReductionDate: prediction?.predictedDate ?? null,
      nextPredictedReductionPercentage: prediction?.predictedPercentage ?? null,
      nextPredictedNewPrice: prediction?.predictedNewPrice ?? null,
      nextPredictedCurrentPrice: predictedItem?.currentAemp ?? null,
      nextPredictedReductionConfidence: prediction?.confidence ?? null,
      nextPredictedReductionSignificance: prediction
        ? predictedReductionSignificance(prediction.predictedPercentage, thresholds)
        : null,
    };
  });
  summaries.sort((a, b) => {
    if (a.isInnovator !== b.isInnovator) return a.isInnovator ? -1 : 1;
    if (!a.isInnovator) {
      const dateOrder = (b.firstListedDate ?? "").localeCompare(a.firstListedDate ?? "");
      if (dateOrder !== 0) return dateOrder;
    }
    return a.brandName.localeCompare(b.brandName);
  });
  res.json(ListMedicineBrandsResponse.parse(summaries));
});

router.get("/medicine-drugs/:id/brands/:brandName/items", async (req, res): Promise<void> => {
  const parsed = ListMedicineBrandItemsParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const [rows, predictions, thresholds] = await Promise.all([
    db
      .select(pbsSelect)
      .from(pbsItemsTable)
      .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
      .where(
        and(
          eq(pbsItemsTable.drugId, parsed.data.id),
          parsed.data.brandName.trim().toLocaleLowerCase() === "crosuva"
            ? or(
                ilike(pbsItemsTable.brandName, "Crosuva 10"),
                ilike(pbsItemsTable.brandName, "Crosuva 20"),
                ilike(pbsItemsTable.brandName, "Crosuva 40"),
              )
            : ilike(pbsItemsTable.brandName, parsed.data.brandName),
        ),
      )
      .orderBy(asc(pbsItemsTable.itemCode)),
    db
      .select({
        itemCode: predictedReductionsTable.itemCode,
        predictedDate: predictedReductionsTable.predictedDate,
        predictedPercentage: predictedReductionsTable.predictedPercentage,
        predictedNewPrice: predictedReductionsTable.predictedNewPrice,
        confidence: predictedReductionsTable.confidence,
        reductionType: predictedReductionsTable.reductionType,
      })
      .from(predictedReductionsTable)
      .where(
        and(
          eq(predictedReductionsTable.drugId, parsed.data.id),
          gte(predictedReductionsTable.predictedDate, today),
          freshPredictionCondition(today),
        ),
      ),
    getPriceChangeThresholds(),
  ]);
  const hiddenBrandKeys = await getHiddenBrandKeys(req.userId as string);
  const visibleRows = rows.filter((row) => !isBrandHidden(hiddenBrandKeys, row.drugId, row.brandName));
  visibleRows.sort((left, right) => {
    const strengthOrder = strengthSortValue(left.strength) - strengthSortValue(right.strength);
    if (strengthOrder !== 0) return strengthOrder;
    return (left.pbsCode ?? left.itemCode).localeCompare(right.pbsCode ?? right.itemCode);
  });
  const predictionsByItem = new Map<string, (typeof predictions)[number][]>();
  for (const prediction of predictions) {
    predictionsByItem.set(prediction.itemCode, [
      ...(predictionsByItem.get(prediction.itemCode) ?? []),
      prediction,
    ]);
  }
  res.json(
    ListMedicineBrandItemsResponse.parse(
      (await enrichPbsItemRows(visibleRows)).map((row) => {
        const prediction = nextPrediction(predictionsByItem.get(row.itemCode) ?? []);
        return {
          ...row,
          upcomingPrediction: prediction
            ? {
                predictedDate: prediction.predictedDate,
                predictedPercentage: prediction.predictedPercentage,
                predictedNewPrice: prediction.predictedNewPrice,
                confidence: prediction.confidence,
                reductionType: prediction.reductionType,
                significance: predictedReductionSignificance(prediction.predictedPercentage, thresholds),
              }
            : null,
        };
      }),
    ),
  );
});

router.get("/anniversary-verification", async (_req, res): Promise<void> => {
  const today = new Date().toISOString().slice(0, 10);
  const latestFiles = await db
    .select({
      id: pbsPublishedFilesTable.id,
      sourceKey: pbsPublishedFilesTable.sourceKey,
      fileName: pbsPublishedFilesTable.fileName,
      reportPublicationDate: pbsPublishedFilesTable.reportPublicationDate,
      effectiveDate: pbsPublishedFilesTable.effectiveDate,
      status: pbsPublishedFilesTable.status,
      parseHealth: pbsPublishedFilesTable.parseHealth,
      retrievedAt: pbsPublishedFilesTable.retrievedAt,
    })
    .from(pbsPublishedFilesTable)
    .where(inArray(pbsPublishedFilesTable.sourceKey, ["anniversary_indicative", "section_99acp"]))
    .orderBy(desc(pbsPublishedFilesTable.retrievedAt))
    .limit(20);
  const latestBySource = ["anniversary_indicative", "section_99acp"]
    .map((sourceKey) => latestFiles.find((file) => file.sourceKey === sourceKey))
    .filter((file): file is NonNullable<typeof file> => Boolean(file));
  const currentFiles = latestBySource.filter((file) =>
    file.status === "completed"
    && file.parseHealth === "healthy"
    && isPublishedReportFresh(file, today),
  );
  const available = currentFiles.length > 0;

  const [catalogueRows, predictionRows, publishedRows] = await Promise.all([
    db
      .select({
        itemCode: pbsItemsTable.itemCode,
        drugId: pbsItemsTable.drugId,
        drugName: drugsTable.name,
        activeIngredient: drugsTable.activeIngredient,
        brandName: pbsItemsTable.brandName,
        form: pbsItemsTable.form,
        liForm: pbsItemsTable.liForm,
        formulary: pbsItemsTable.formulary,
      })
      .from(pbsItemsTable)
      .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id)),
    db
      .select({
        id: predictedReductionsTable.id,
        itemCode: predictedReductionsTable.itemCode,
        drugId: predictedReductionsTable.drugId,
        drugName: drugsTable.name,
        brandName: pbsItemsTable.brandName,
        formulary: pbsItemsTable.formulary,
        predictedDate: predictedReductionsTable.predictedDate,
        reductionType: predictedReductionsTable.reductionType,
        predictedPercentage: predictedReductionsTable.predictedPercentage,
        predictedNewPrice: predictedReductionsTable.predictedNewPrice,
        currentPrice: pbsItemsTable.currentAemp,
      })
      .from(predictedReductionsTable)
      .innerJoin(pbsItemsTable, eq(predictedReductionsTable.itemCode, pbsItemsTable.itemCode))
      .innerJoin(drugsTable, eq(predictedReductionsTable.drugId, drugsTable.id))
      .where(
        and(
          gte(predictedReductionsTable.predictedDate, today),
          freshPredictionCondition(today),
          ilike(predictedReductionsTable.reductionType, "%year statutory reduction"),
        ),
      ),
    currentFiles.length
      ? db
          .select({
            id: pbsPublishedFileRowsTable.id,
            fileId: pbsPublishedFileRowsTable.fileId,
            sourceRowNumber: pbsPublishedFileRowsTable.sourceRowNumber,
            sourceDrugName: pbsPublishedFileRowsTable.sourceDrugName,
            sourceMoa: pbsPublishedFileRowsTable.sourceMoa,
            rawRow: pbsPublishedFileRowsTable.rawRow,
            effectDate: pbsPublishedFileRowsTable.effectDate,
          })
          .from(pbsPublishedFileRowsTable)
          .where(inArray(pbsPublishedFileRowsTable.fileId, currentFiles.map((file) => file.id)))
          .orderBy(asc(pbsPublishedFileRowsTable.sourceRowNumber))
      : Promise.resolve([]),
  ]);

  const verification = buildAnniversaryVerification({
    publishedRows: publishedRows as AnniversaryPublishedRow[],
    catalogueItems: catalogueRows as AnniversaryCatalogueItem[],
    predictions: predictionRows as AnniversaryPrediction[],
  });
  res.json(
    ListAnniversaryVerificationResponse.parse({
      available,
      sources: currentFiles.map((file) => ({
        sourceKey: file.sourceKey,
        sourceFileId: file.id,
        sourceFileName: file.fileName,
        reportPublicationDate: file.reportPublicationDate,
        effectiveDate: file.effectiveDate,
      })),
      sourceFileId: currentFiles.length === 1 ? currentFiles[0]?.id ?? null : null,
      sourceFileName: currentFiles.length ? currentFiles.map((file) => file.fileName).join(" · ") : null,
      reportPublicationDate: currentFiles.length
        ? currentFiles.map((file) => file.reportPublicationDate).filter(Boolean).sort().at(-1) ?? null
        : null,
      effectiveDate: currentFiles.length
        ? currentFiles.map((file) => file.effectiveDate).filter(Boolean).sort().at(-1) ?? null
        : null,
      predictions: verification.predictions,
      publishedRows: verification.publishedRows,
    }),
  );
});

router.get("/upcoming-predicted-reductions", async (req, res): Promise<void> => {
  const parsed = ListUpcomingPredictedReductionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const from = queryDateOnly(parsed.data.from) ?? new Date().toISOString().slice(0, 10);
  const to = queryDateOnly(parsed.data.to);
  const [rows, thresholds] = await Promise.all([
    db
    .select({
      itemCode: predictedReductionsTable.itemCode,
      pbsCode: pbsItemsTable.pbsCode,
      drugId: predictedReductionsTable.drugId,
      drugName: drugsTable.name,
      brandName: pbsItemsTable.brandName,
      strength: pbsItemsTable.strength,
      currentPrice: pbsItemsTable.currentAemp,
      predictedNewPrice: predictedReductionsTable.predictedNewPrice,
      predictedPercentage: predictedReductionsTable.predictedPercentage,
      predictedDate: predictedReductionsTable.predictedDate,
      confidence: predictedReductionsTable.confidence,
      reductionType: predictedReductionsTable.reductionType,
      subjectToMinisterialDiscretion: predictedReductionsTable.subjectToMinisterialDiscretion,
      sourceNote: predictedReductionsTable.sourceNote,
    })
    .from(predictedReductionsTable)
    .innerJoin(pbsItemsTable, eq(predictedReductionsTable.itemCode, pbsItemsTable.itemCode))
    .innerJoin(drugsTable, eq(predictedReductionsTable.drugId, drugsTable.id))
    .where(
      and(
        gte(predictedReductionsTable.predictedDate, from),
        to ? lte(predictedReductionsTable.predictedDate, to) : undefined,
        parsed.data.confidence ? eq(predictedReductionsTable.confidence, parsed.data.confidence) : undefined,
        freshPredictionCondition(from),
      ),
    ),
    getPriceChangeThresholds(),
  ]);
  const hiddenBrandKeys = await getHiddenBrandKeys(req.userId as string);
  const visibleRows = rows.filter((row) => !isBrandHidden(hiddenBrandKeys, row.drugId, row.brandName));
  const visibleDrugIds = [...new Set(visibleRows.map((row) => row.drugId))];
  const originatorItems = visibleDrugIds.length
    ? await db
        .select({
          drugId: pbsItemsTable.drugId,
          brandName: pbsItemsTable.brandName,
          innovatorIndicator: pbsItemsTable.innovatorIndicator,
        })
        .from(pbsItemsTable)
        .where(inArray(pbsItemsTable.drugId, visibleDrugIds))
    : [];
  const originatorBrandByDrug = new Map<number, string>();
  for (const item of originatorItems) {
    if (
      indicatorIsTrue(item.innovatorIndicator)
      && !isBrandHidden(hiddenBrandKeys, item.drugId, item.brandName)
      && !originatorBrandByDrug.has(item.drugId)
    ) {
      originatorBrandByDrug.set(item.drugId, item.brandName);
    }
  }
  type BrandGroup = {
    brandName: string;
    strength: string | null;
    currentPrice: number;
    predictedNewPrice: number;
    predictedPercentage: number;
    predictedDate: string;
    confidence: string;
    reductionType: string;
    significance: "normal" | "medium" | "high";
    listings: Array<{
      itemCode: string;
      pbsCode: string | null;
      strength: string | null;
      currentPrice: number;
      predictedNewPrice: number;
      predictedPercentage: number;
      predictedDate: string;
      confidence: string;
      reductionType: string;
      subjectToMinisterialDiscretion: boolean;
      sourceNote: string;
      significance: "normal" | "medium" | "high";
    }>;
  };
  const groups = new Map<string, {
    drugId: number;
    drugName: string;
    predictedDate: string;
    currentPrice: number;
    predictedNewPrice: number;
    predictedPercentage: number;
    brands: Map<string, BrandGroup>;
  }>();
  for (const row of visibleRows) {
    const predictedDate = dateOnly(row.predictedDate);
    const groupKey = [
      row.drugId,
      predictedDate,
      row.currentPrice,
      row.predictedNewPrice,
      row.predictedPercentage,
    ].join(":");
    const group = groups.get(groupKey) ?? {
      drugId: row.drugId,
      drugName: row.drugName,
      predictedDate,
      currentPrice: row.currentPrice,
      predictedNewPrice: row.predictedNewPrice,
      predictedPercentage: row.predictedPercentage,
      brands: new Map<string, BrandGroup>(),
    };
    const brandKey = brandGroupKey(row.brandName);
    const significance = predictedReductionSignificance(row.predictedPercentage, thresholds);
    const brand = group.brands.get(brandKey) ?? {
      brandName: brandGroupName(row.brandName),
      strength: row.strength,
      currentPrice: row.currentPrice,
      predictedNewPrice: row.predictedNewPrice,
      predictedPercentage: row.predictedPercentage,
      predictedDate,
      confidence: row.confidence,
      reductionType: row.reductionType,
      significance,
      listings: [],
    };
    if (brand.strength !== row.strength) brand.strength = null;
    brand.listings.push({
      itemCode: row.itemCode,
      pbsCode: row.pbsCode,
      strength: row.strength,
      currentPrice: row.currentPrice,
      predictedNewPrice: row.predictedNewPrice,
      predictedPercentage: row.predictedPercentage,
      predictedDate,
      confidence: row.confidence,
      reductionType: row.reductionType,
      subjectToMinisterialDiscretion: row.subjectToMinisterialDiscretion,
      sourceNote: row.sourceNote,
      significance,
    });
    group.brands.set(brandKey, brand);
    groups.set(groupKey, group);
  }
  const response = [...groups.values()].map((group) => {
    const brands = [...group.brands.values()]
      .map((brand) => ({ ...brand, listingCount: brand.listings.length, listings: brand.listings.sort((left, right) => (left.pbsCode ?? left.itemCode).localeCompare(right.pbsCode ?? right.itemCode)) }))
      .sort((left, right) => left.brandName.localeCompare(right.brandName));
    return {
      drugId: group.drugId,
      drugName: group.drugName,
      originatorBrandName: originatorBrandByDrug.get(group.drugId) ?? null,
      predictedDate: group.predictedDate,
      currentPrice: group.currentPrice,
      predictedNewPrice: group.predictedNewPrice,
      predictedPercentage: group.predictedPercentage,
      brandCount: brands.length,
      listingCount: brands.reduce((total, brand) => total + brand.listingCount, 0),
      significance: predictedReductionSignificance(group.predictedPercentage, thresholds),
      brands,
    };
  }).sort(
    (left, right) =>
      Math.abs(right.predictedPercentage) - Math.abs(left.predictedPercentage) ||
      left.predictedDate.localeCompare(right.predictedDate) ||
      left.drugName.localeCompare(right.drugName),
  );
  res.json(ListUpcomingPredictedReductionsResponse.parse(response));
});

router.get("/pbs-items", async (req, res): Promise<void> => {
  const parsed = ListPbsItemsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, formulary, limit = 50 } = parsed.data;
  const searchTokens = search
    ? [...new Set(search.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean))]
    : [];
  const normalizedStrength = sql<string>`regexp_replace(lower(coalesce(${pbsItemsTable.strength}, '')), '[^a-z0-9]+', '', 'g')`;
  const rows = await db
    .select(pbsSelect)
    .from(pbsItemsTable)
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(
      and(
        formulary ? eq(pbsItemsTable.formulary, formulary) : undefined,
        ...searchTokens.map((token) =>
          or(
            ilike(pbsItemsTable.itemCode, `%${token}%`),
            ilike(pbsItemsTable.pbsCode, `%${token}%`),
            ilike(pbsItemsTable.brandName, `%${token}%`),
            ilike(drugsTable.name, `%${token}%`),
            ilike(drugsTable.activeIngredient, `%${token}%`),
            ilike(normalizedStrength, `%${token}%`),
          ),
        ),
      ),
    )
    .orderBy(asc(pbsItemsTable.brandName))
    .limit(limit);
  res.json(ListPbsItemsResponse.parse(await enrichPbsItemRows(rows)));
});

router.get("/pbs-items/:itemCode", async (req, res): Promise<void> => {
  const parsed = GetPbsItemParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .select(pbsSelect)
    .from(pbsItemsTable)
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(eq(pbsItemsTable.itemCode, parsed.data.itemCode));
  if (!row) {
    res.status(404).json({ error: "PBS item not found" });
    return;
  }
  res.json(GetPbsItemResponse.parse((await enrichPbsItemRows([row]))[0]));
});

router.get("/pbs-items/:itemCode/price-history", async (req, res): Promise<void> => {
  const parsed = ListPriceHistoryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(priceHistoryTable)
    .where(eq(priceHistoryTable.itemCode, parsed.data.itemCode))
    .orderBy(desc(priceHistoryTable.priceDate));
  res.json(ListPriceHistoryResponse.parse(rows));
});

router.get("/pbs-items/:itemCode/premium-history", async (req, res): Promise<void> => {
  const parsed = ListItemPremiumHistoryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(pbsItemPremiumHistoryTable)
    .where(eq(pbsItemPremiumHistoryTable.itemCode, parsed.data.itemCode))
    .orderBy(
      desc(pbsItemPremiumHistoryTable.scheduleEffectiveDate),
      asc(pbsItemPremiumHistoryTable.dispensingRuleReference),
    );
  res.json(ListItemPremiumHistoryResponse.parse(rows));
});

router.get("/pbs-items/:itemCode/predicted-reductions", async (req, res): Promise<void> => {
  const parsed = ListItemPredictedReductionsParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const [rows, thresholds] = await Promise.all([
    db
    .select()
    .from(predictedReductionsTable)
    .where(
      and(
        eq(predictedReductionsTable.itemCode, parsed.data.itemCode),
        gte(predictedReductionsTable.predictedDate, today),
        freshPredictionCondition(today),
      ),
    )
    .orderBy(asc(predictedReductionsTable.predictedDate)),
    getPriceChangeThresholds(),
  ]);
  res.json(
    ListItemPredictedReductionsResponse.parse(
      rows.map((row) => ({
        ...row,
        significance: predictedReductionSignificance(row.predictedPercentage, thresholds),
      })),
    ),
  );
});

const scheduleChangeSelect = {
  id: scheduleChangesTable.id,
  scheduleCode: scheduleChangesTable.scheduleCode,
  effectiveDate: scheduleChangesTable.effectiveDate,
  changeType: scheduleChangesTable.changeType,
  liItemId: scheduleChangesTable.liItemId,
  pbsCode: scheduleChangesTable.pbsCode,
  drugId: scheduleChangesTable.drugId,
  drugName: drugsTable.name,
  brandName: scheduleChangesTable.brandName,
  oldValue: scheduleChangesTable.oldValue,
  newValue: scheduleChangesTable.newValue,
  affectedItems: scheduleChangesTable.affectedItems,
  significance: scheduleChangesTable.significance,
  notes: scheduleChangesTable.notes,
  createdAt: scheduleChangesTable.createdAt,
};

async function enrichScheduleChangeRows<T extends {
  drugId: number;
  liItemId: string | null;
  affectedItems: ScheduleChangeAffectedItem[] | null;
}>(rows: T[]): Promise<T[]> {
  const drugIds = [...new Set(rows.map((row) => row.drugId))];
  const itemIdentifiers = [
    ...new Set([
      ...rows.map((row) => row.liItemId),
      ...rows.flatMap((row) => row.affectedItems?.map((item) => item.liItemId) ?? []),
    ].filter((value): value is string => Boolean(value))),
  ];
  const [matchingItems, originatorItems] = await Promise.all([
    itemIdentifiers.length
      ? db
          .select({
            itemCode: pbsItemsTable.itemCode,
            liItemId: pbsItemsTable.liItemId,
            pbsCode: pbsItemsTable.pbsCode,
            brandName: pbsItemsTable.brandName,
            strength: pbsItemsTable.strength,
            determinedPrice: pbsItemsTable.determinedPrice,
            formulary: pbsItemsTable.formulary,
          })
          .from(pbsItemsTable)
          .where(or(inArray(pbsItemsTable.itemCode, itemIdentifiers), inArray(pbsItemsTable.liItemId, itemIdentifiers)))
      : [],
    drugIds.length
      ? db
          .select({
            drugId: pbsItemsTable.drugId,
            brandName: pbsItemsTable.brandName,
            innovatorIndicator: pbsItemsTable.innovatorIndicator,
          })
          .from(pbsItemsTable)
          .where(inArray(pbsItemsTable.drugId, drugIds))
      : [],
  ]);
  const itemsByIdentifier = new Map(
    matchingItems.flatMap((item) => [
      [item.itemCode, item],
      ...(item.liItemId ? [[item.liItemId, item] as const] : []),
    ]),
  );
  const originatorBrandByDrug = new Map<number, string>();
  for (const item of originatorItems) {
    if (indicatorIsTrue(item.innovatorIndicator) && !originatorBrandByDrug.has(item.drugId)) {
      originatorBrandByDrug.set(item.drugId, item.brandName);
    }
  }

  return rows.map((row) => {
    const rowWithOriginator = {
      ...row,
      originatorBrandName: originatorBrandByDrug.get(row.drugId) ?? null,
    };
    const fillItem = (item: ScheduleChangeAffectedItem): ScheduleChangeAffectedItem => {
      const current = itemsByIdentifier.get(item.liItemId);
      if (!current) return item;
      return {
        ...item,
        pbsCode: item.pbsCode ?? current.pbsCode,
        brandName: item.brandName || current.brandName,
        strength: item.strength ?? current.strength,
        determinedPrice: item.determinedPrice ?? current.determinedPrice,
        formulary: item.formulary ?? current.formulary,
      };
    };
    if (row.affectedItems?.length) {
      return { ...rowWithOriginator, affectedItems: row.affectedItems.map(fillItem) };
    }
    if (!row.liItemId) return rowWithOriginator;
    const current = itemsByIdentifier.get(row.liItemId);
    return current
      ? {
          ...rowWithOriginator,
          affectedItems: [{
            liItemId: current.liItemId ?? current.itemCode,
            pbsCode: current.pbsCode,
            brandName: current.brandName,
            strength: current.strength,
            determinedPrice: current.determinedPrice,
            formulary: current.formulary,
          }],
        }
      : rowWithOriginator;
  });
}

router.get("/pbs-items/:itemCode/schedule-changes", async (req, res): Promise<void> => {
  const parsed = ListItemScheduleChangesParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db
    .select(scheduleChangeSelect)
    .from(scheduleChangesTable)
    .innerJoin(drugsTable, eq(scheduleChangesTable.drugId, drugsTable.id))
    .where(
        or(
          eq(scheduleChangesTable.liItemId, parsed.data.itemCode),
          eq(scheduleChangesTable.pbsCode, parsed.data.itemCode),
          sql`${scheduleChangesTable.affectedItems} @> ${JSON.stringify([{ liItemId: parsed.data.itemCode }])}::jsonb`,
          sql`${scheduleChangesTable.affectedItems} @> ${JSON.stringify([{ pbsCode: parsed.data.itemCode }])}::jsonb`,
        ),
    )
    .orderBy(desc(scheduleChangesTable.effectiveDate), desc(scheduleChangesTable.id));
  res.json(ListItemScheduleChangesResponse.parse(await enrichScheduleChangeRows(rows)));
});

router.get("/schedule-changes", async (req, res): Promise<void> => {
  const parsed = ListScheduleChangesQueryParams.safeParse({
    ...req.query,
    from: parseDateQueryValue(req.query.from),
    to: parseDateQueryValue(req.query.to),
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { drugId, scheduleCode, from, to, changeType, direction, significance, limit = 200 } = parsed.data;
  const rows = await db
    .select(scheduleChangeSelect)
    .from(scheduleChangesTable)
    .innerJoin(drugsTable, eq(scheduleChangesTable.drugId, drugsTable.id))
    .where(
      and(
        drugId ? eq(scheduleChangesTable.drugId, drugId) : undefined,
        scheduleCode !== undefined ? eq(scheduleChangesTable.scheduleCode, scheduleCode) : undefined,
        from ? gte(scheduleChangesTable.effectiveDate, queryDateOnly(from)!) : undefined,
        to ? lte(scheduleChangesTable.effectiveDate, queryDateOnly(to)!) : undefined,
        changeType ? eq(scheduleChangesTable.changeType, changeType) : undefined,
        significance ? eq(scheduleChangesTable.significance, significance) : undefined,
      ),
    )
    .orderBy(desc(scheduleChangesTable.effectiveDate), desc(scheduleChangesTable.id))
    .limit(limit);
  const hiddenBrandKeys = await getHiddenBrandKeys(req.userId as string);
  const visibleRows = rows
    .filter((row) => !isBrandHidden(hiddenBrandKeys, row.drugId, row.brandName))
    .filter((row) => direction !== "decrease" || row.changeType !== "price_change" || isPriceReduction(row));
  res.json(ListScheduleChangesResponse.parse(await enrichScheduleChangeRows(visibleRows)));
});

router.get("/drugs/:id/schedule-timeline", async (req, res): Promise<void> => {
  const parsed = GetDrugScheduleTimelineParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db
    .select(scheduleChangeSelect)
    .from(scheduleChangesTable)
    .innerJoin(drugsTable, eq(scheduleChangesTable.drugId, drugsTable.id))
    .where(eq(scheduleChangesTable.drugId, parsed.data.id))
    .orderBy(asc(scheduleChangesTable.effectiveDate), asc(scheduleChangesTable.id));
  res.json(GetDrugScheduleTimelineResponse.parse(await enrichScheduleChangeRows(rows)));
});

router.get("/artg-entries", async (req, res): Promise<void> => {
  const parsed = ListArtgEntriesQueryParams.safeParse({
    ...req.query,
    from: parseDateQueryValue(req.query.from),
    to: parseDateQueryValue(req.query.to),
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, status, pbs, from, to } = parsed.data;
  const [rows, pbsItems] = await Promise.all([
    db
      .select()
      .from(artgEntriesTable)
      .where(
        and(
          status ? ilike(artgEntriesTable.status, status) : undefined,
          from ? gte(artgEntriesTable.registrationDate, queryDateOnly(from)!) : undefined,
          to ? lte(artgEntriesTable.registrationDate, queryDateOnly(to)!) : undefined,
          search
            ? or(
                ilike(artgEntriesTable.artgId, `%${search}%`),
                ilike(artgEntriesTable.activeIngredient, `%${search}%`),
                ilike(artgEntriesTable.sponsor, `%${search}%`),
                ilike(artgEntriesTable.productName, `%${search}%`),
              )
            : undefined,
        ),
      )
      .orderBy(asc(artgEntriesTable.productName)),
    db.select({ drugId: pbsItemsTable.drugId, brandName: pbsItemsTable.brandName }).from(pbsItemsTable),
  ]);
  const brandsByDrug = new Map<number, string[]>();
  for (const item of pbsItems) {
    brandsByDrug.set(item.drugId, [...(brandsByDrug.get(item.drugId) ?? []), item.brandName]);
  }
  const today = new Date();
  const entries = rows.map((row) => {
    const candidateBrands = row.matchedDrugId ? brandsByDrug.get(row.matchedDrugId) ?? [] : [];
    const pbsBrandNames = [...new Set(candidateBrands.filter((brand) =>
      pbsBrandMatchesArtgProduct(row.productName, brand),
    ))].sort((a, b) => a.localeCompare(b));
    const registration = new Date(`${row.registrationDate}T00:00:00Z`);
    const daysSinceRegistration = Number.isNaN(registration.getTime())
      ? 0
      : Math.max(0, Math.floor((today.getTime() - registration.getTime()) / 86_400_000));
    return {
      artgId: row.artgId,
      activeIngredient: row.activeIngredient,
      sponsor: row.sponsor,
      registrationDate: row.registrationDate,
      productName: row.productName,
      status: row.status,
      matchedDrugId: row.matchedDrugId,
      pbsListed: pbsBrandNames.length > 0,
      pbsBrandNames,
      daysSinceRegistration,
    };
  });
  res.json(ListArtgEntriesResponse.parse(entries.filter((entry) =>
    !pbs || pbs === "all" || (pbs === "listed" ? entry.pbsListed : !entry.pbsListed),
  )));
});

router.get("/artg-import-status", async (_req, res): Promise<void> => {
  const artgStaleAfterMs = 45 * 24 * 60 * 60 * 1_000;
  const [successful] = await db
    .select({ finishedAt: artgIngestionRunsTable.finishedAt })
    .from(artgIngestionRunsTable)
    .where(and(eq(artgIngestionRunsTable.status, "completed"), gt(artgIngestionRunsTable.recordsAccepted, 0)))
    .orderBy(desc(artgIngestionRunsTable.finishedAt))
    .limit(1);
  const [attempt] = await db
    .select({
      startedAt: artgIngestionRunsTable.startedAt,
      status: artgIngestionRunsTable.status,
      errorMessage: artgIngestionRunsTable.errorMessage,
    })
    .from(artgIngestionRunsTable)
    .orderBy(desc(artgIngestionRunsTable.startedAt))
    .limit(1);
  res.json(GetArtgImportStatusResponse.parse({
    hasSuccessfulImport: Boolean(successful),
    isStale: Boolean(successful?.finishedAt && Date.now() - successful.finishedAt.getTime() > artgStaleAfterMs),
    lastSuccessfulImportAt: successful?.finishedAt ?? null,
    lastAttemptAt: attempt?.startedAt ?? null,
    lastAttemptStatus: attempt?.status ?? null,
    lastErrorMessage: attempt?.errorMessage ?? null,
  }));
});

  return router;
}

export default createReferenceRouter();