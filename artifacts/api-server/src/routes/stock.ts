import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  artgEntriesTable,
  drugsTable,
  ingestionRunsTable,
  pharmacyStockTable,
  pbsItemsTable,
  predictedReductionsTable,
  scheduleChangesTable,
} from "@workspace/db";
import {
  CreateStockBody,
  CreateStockResponse,
  DashboardSummary,
  DeleteStockParams,
  GetDashboardResponse,
  ListStockResponse,
  UpdateStockBody,
  UpdateStockParams,
  UpdateStockResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getHiddenBrandKeys, isBrandHidden } from "../lib/brand-preferences";
import { pbsBrandMatchesArtgProduct } from "../lib/artg-import";

export function dashboardPriceReduction(oldValue: unknown, newValue: unknown): boolean {
  const readPrice = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const price = (value as Record<string, unknown>).determined_price;
    if (typeof price === "number" && Number.isFinite(price)) return price;
    if (typeof price === "string" && price.trim() && Number.isFinite(Number(price))) return Number(price);
    return null;
  };
  const oldPrice = readPrice(oldValue);
  const newPrice = readPrice(newValue);
  return oldPrice !== null && newPrice !== null && newPrice < oldPrice;
}

export function createStockRouter(
  database: typeof db = db,
  authMiddleware: typeof requireAuth = requireAuth,
): IRouter {
  const router: IRouter = Router();

const stockSelect = {
  id: pharmacyStockTable.id,
  userId: pharmacyStockTable.userId,
  itemCode: pharmacyStockTable.itemCode,
  pbsCode: pbsItemsTable.pbsCode,
  brandName: pbsItemsTable.brandName,
  drugName: drugsTable.name,
  activeIngredient: drugsTable.activeIngredient,
  strength: pbsItemsTable.strength,
  form: pbsItemsTable.form,
  packSize: pbsItemsTable.packSize,
  benefitTypeCode: pbsItemsTable.benefitTypeCode,
  maximumQuantityUnits: pbsItemsTable.maximumQuantityUnits,
  formulary: pbsItemsTable.formulary,
  quantity: pharmacyStockTable.quantity,
  purchasePrice: pharmacyStockTable.purchasePrice,
  purchaseDate: pharmacyStockTable.purchaseDate,
  invoiceReference: pharmacyStockTable.invoiceReference,
};

async function getUserStock(userId: string) {
  return database
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(eq(pharmacyStockTable.userId, userId))
    .orderBy(desc(pharmacyStockTable.purchaseDate), desc(pharmacyStockTable.id));
}

async function getUserExposure(userId: string) {
  const rows = await getUserStock(userId);
  const itemCodes = [...new Set(rows.map((row) => row.itemCode))];
  const today = new Date().toISOString().slice(0, 10);
  const predictions = itemCodes.length
    ? await database
        .select({
          itemCode: predictedReductionsTable.itemCode,
          predictedDate: predictedReductionsTable.predictedDate,
          reductionType: predictedReductionsTable.reductionType,
          predictedPercentage: predictedReductionsTable.predictedPercentage,
          predictedNewPrice: predictedReductionsTable.predictedNewPrice,
          confidence: predictedReductionsTable.confidence,
        })
        .from(predictedReductionsTable)
        .where(
          and(
            inArray(predictedReductionsTable.itemCode, itemCodes),
            gte(predictedReductionsTable.predictedDate, today),
          ),
        )
        .orderBy(asc(predictedReductionsTable.predictedDate), asc(predictedReductionsTable.id))
    : [];

  const predictionByItemCode = new Map<
    string,
    (typeof predictions)[number]
  >();
  for (const prediction of predictions) {
    const existing = predictionByItemCode.get(prediction.itemCode);
    if (
      !existing
      || prediction.predictedDate < existing.predictedDate
      || (
        prediction.predictedDate === existing.predictedDate
        && prediction.confidence === "confirmed"
        && existing.confidence !== "confirmed"
      )
    ) {
      predictionByItemCode.set(prediction.itemCode, prediction);
    }
  }

  const exposureRows = rows.map((row) => {
    const prediction = predictionByItemCode.get(row.itemCode) ?? null;
    const perPackExposure = prediction
      ? Number(Math.max(0, row.purchasePrice - prediction.predictedNewPrice).toFixed(2))
      : 0;
    const totalExposure = Number((perPackExposure * row.quantity).toFixed(2));
    return {
      ...row,
      prediction,
      perPackExposure,
      totalExposure,
    };
  });

  exposureRows.sort((left, right) => {
    if (right.totalExposure !== left.totalExposure) {
      return right.totalExposure - left.totalExposure;
    }
    if (left.prediction && right.prediction) {
      const dateOrder = left.prediction.predictedDate.localeCompare(right.prediction.predictedDate);
      if (dateOrder !== 0) return dateOrder;
    }
    if (Boolean(right.prediction) !== Boolean(left.prediction)) {
      return right.prediction ? 1 : -1;
    }
    return right.id - left.id;
  });

  const byDate = new Map<string, { totalExposure: number; lineCount: number }>();
  for (const row of exposureRows) {
    if (!row.prediction) continue;
    const current = byDate.get(row.prediction.predictedDate) ?? { totalExposure: 0, lineCount: 0 };
    current.totalExposure = Number((current.totalExposure + row.totalExposure).toFixed(2));
    current.lineCount += 1;
    byDate.set(row.prediction.predictedDate, current);
  }
  const summary = {
    totalExposure: Number(
      exposureRows.reduce((total, row) => total + row.totalExposure, 0).toFixed(2),
    ),
    totalAtRiskLines: exposureRows.filter((row) => row.totalExposure > 0).length,
    exposureByDate: [...byDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([predictedDate, values]) => ({ predictedDate, ...values })),
  };

  return { rows: exposureRows, summary };
}

type DashboardChange = {
  scheduleCode: number;
  effectiveDate: string;
  changeType: string;
  drugId: number;
  brandName: string | null;
  oldValue: unknown;
  newValue: unknown;
  affectedItems: Array<{ brandName: string }> | null;
};

type DashboardPeriodKey = "this_schedule" | "three_months" | "twelve_months";

function dateMonthsAgo(dateValue: string, months: number): string {
  const [year, month, day] = dateValue.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1 - months, day));
  return result.toISOString().slice(0, 10);
}

function isPriceReduction(change: DashboardChange): boolean {
  return dashboardPriceReduction(change.oldValue, change.newValue);
}

function isVisibleDashboardChange(change: DashboardChange, hiddenBrandKeys: Set<string>): boolean {
  if (change.brandName && !isBrandHidden(hiddenBrandKeys, change.drugId, change.brandName)) return true;
  if (change.affectedItems?.length) {
    return change.affectedItems.some((item) => !isBrandHidden(hiddenBrandKeys, change.drugId, item.brandName));
  }
  return !change.brandName;
}

function upcomingEventKey(row: { drugId: number; predictedDate: string; currentPrice: number; predictedNewPrice: number; predictedPercentage: number }): string {
  return [
    row.drugId,
    row.predictedDate.slice(0, 10),
    row.currentPrice,
    row.predictedNewPrice,
    row.predictedPercentage,
  ].join(":");
}

async function getDashboardSummary(database: typeof db, userId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const twelveMonthsAgo = dateMonthsAgo(today, 12);
  const [currentRun, activeRun] = await Promise.all([
    database
      .select({
        scheduleCode: ingestionRunsTable.scheduleCode,
        effectiveDate: ingestionRunsTable.scheduleEffectiveDate,
        finishedAt: ingestionRunsTable.finishedAt,
      })
      .from(ingestionRunsTable)
      .where(
        and(
          eq(ingestionRunsTable.status, "completed"),
          eq(ingestionRunsTable.snapshotComplete, true),
          isNotNull(ingestionRunsTable.scheduleCode),
          isNotNull(ingestionRunsTable.scheduleEffectiveDate),
        ),
      )
      .orderBy(desc(ingestionRunsTable.finishedAt))
      .limit(1),
    database
      .select({ id: ingestionRunsTable.id })
      .from(ingestionRunsTable)
      .where(inArray(ingestionRunsTable.status, ["queued", "running"]))
      .limit(1),
  ]);
  const completed = currentRun[0];
  const scheduleAvailable = completed?.scheduleCode !== null
    && completed?.scheduleCode !== undefined
    && Boolean(completed.effectiveDate);
  const currentSchedule = {
    status: activeRun.length && !completed ? "in_progress" : scheduleAvailable ? "available" : activeRun.length ? "in_progress" : "unavailable",
    scheduleCode: completed?.scheduleCode ?? null,
    effectiveDate: completed?.effectiveDate ?? null,
    lastSuccessfulIngestionAt: completed?.finishedAt ?? null,
  } as const;

  const [changeRows, predictionRows, artgRows, pbsBrands] = await Promise.all([
    database
      .select({
        scheduleCode: scheduleChangesTable.scheduleCode,
        effectiveDate: scheduleChangesTable.effectiveDate,
        changeType: scheduleChangesTable.changeType,
        drugId: scheduleChangesTable.drugId,
        brandName: scheduleChangesTable.brandName,
        oldValue: scheduleChangesTable.oldValue,
        newValue: scheduleChangesTable.newValue,
        affectedItems: scheduleChangesTable.affectedItems,
      })
      .from(scheduleChangesTable)
      .where(gte(scheduleChangesTable.effectiveDate, twelveMonthsAgo)),
    database
      .select({
        drugId: predictedReductionsTable.drugId,
        predictedDate: predictedReductionsTable.predictedDate,
        brandName: pbsItemsTable.brandName,
        currentPrice: pbsItemsTable.currentAemp,
        predictedNewPrice: predictedReductionsTable.predictedNewPrice,
        predictedPercentage: predictedReductionsTable.predictedPercentage,
      })
      .from(predictedReductionsTable)
      .innerJoin(pbsItemsTable, eq(predictedReductionsTable.itemCode, pbsItemsTable.itemCode))
      .where(
        and(
          gte(predictedReductionsTable.predictedDate, today),
          lte(predictedReductionsTable.predictedDate, dateMonthsAgo(today, -12)),
        ),
      ),
    database
      .select({
        matchedDrugId: artgEntriesTable.matchedDrugId,
        registrationDate: artgEntriesTable.registrationDate,
        productName: artgEntriesTable.productName,
        status: artgEntriesTable.status,
      })
      .from(artgEntriesTable)
      .where(
        and(
          gte(artgEntriesTable.registrationDate, twelveMonthsAgo),
          lte(artgEntriesTable.registrationDate, today),
        ),
      ),
    database
      .select({ drugId: pbsItemsTable.drugId, brandName: pbsItemsTable.brandName })
      .from(pbsItemsTable),
  ]);
  const hiddenBrandKeys = await getHiddenBrandKeys(userId);
  const visibleChanges = (changeRows as DashboardChange[]).filter((change) =>
    isVisibleDashboardChange(change, hiddenBrandKeys),
  );
  const brandsByDrug = new Map<number, string[]>();
  for (const item of pbsBrands) {
    brandsByDrug.set(item.drugId, [...(brandsByDrug.get(item.drugId) ?? []), item.brandName]);
  }
  const unlistedArtgCount = (from: string, to: string | null) => artgRows.filter((entry) => {
    const status = entry.status.trim().toLocaleUpperCase();
    if (!status.includes("REGISTER")) return false;
    if (entry.registrationDate < from || (to && entry.registrationDate > to)) return false;
    const candidateBrands = entry.matchedDrugId ? brandsByDrug.get(entry.matchedDrugId) ?? [] : [];
    return !candidateBrands.some((brand) => pbsBrandMatchesArtgProduct(entry.productName, brand));
  }).length;

  const periodDefinitions: Array<{ key: DashboardPeriodKey; label: string; from: string | null; to: string | null }> = [
    { key: "this_schedule", label: "This schedule", from: completed?.effectiveDate ?? null, to: null },
    { key: "three_months", label: "3 months", from: dateMonthsAgo(today, 3), to: today },
    { key: "twelve_months", label: "12 months", from: twelveMonthsAgo, to: today },
  ];
  const periods = periodDefinitions.map((period) => {
    const available = scheduleAvailable;
    const changes = available
      ? visibleChanges.filter((change) =>
          period.key === "this_schedule"
            ? change.scheduleCode === completed?.scheduleCode
            : change.effectiveDate >= (period.from ?? twelveMonthsAgo) && change.effectiveDate <= (period.to ?? today),
        )
      : [];
    const predictions = available
      ? predictionRows
        .filter((row) => !isBrandHidden(hiddenBrandKeys, row.drugId, row.brandName))
        .filter((row) => {
          if (period.key === "this_schedule") return row.predictedDate >= today;
          const futureTo = dateMonthsAgo(today, period.key === "three_months" ? -3 : -12);
          return row.predictedDate >= today && row.predictedDate <= futureTo;
        })
      : [];
    const predictionEvents = new Set(predictions.map(upcomingEventKey));
    const nextUpcomingReductionDate = predictions
      .map((row) => row.predictedDate.slice(0, 10))
      .sort()[0] ?? null;
    return {
      key: period.key,
      label: period.label,
      from: period.from,
      to: period.to,
      available,
      counts: {
        newBrands: changes.filter((change) => change.changeType === "new_brand").length,
        priceReductions: changes.filter((change) => change.changeType === "price_change" && isPriceReduction(change)).length,
        delistings: changes.filter((change) => change.changeType === "delisted").length,
        formularyChanges: changes.filter((change) => change.changeType === "formulary_change").length,
        amendedListings: changes.filter((change) => change.changeType === "listing_amendment").length,
        upcomingReductions: predictionEvents.size,
        artgNotPbsListed: unlistedArtgCount(period.from ?? twelveMonthsAgo, period.to),
      },
      nextUpcomingReductionDate,
    };
  });
  return { periods, currentSchedule };
}

router.get("/dashboard", authMiddleware, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const rows = await getUserStock(userId);
  const itemCodes = new Set(rows.map((row) => row.itemCode));
  const itemDetails = itemCodes.size
    ? await database
        .select({ itemCode: pbsItemsTable.itemCode, formulary: pbsItemsTable.formulary })
        .from(pbsItemsTable)
        .where(sql`${pbsItemsTable.itemCode} in (${sql.join([...itemCodes].map((code) => sql`${code}`), sql`, `)})`)
    : [];
  const formularyBreakdown = itemDetails.reduce(
    (breakdown, item) => {
      breakdown[item.formulary] += 1;
      return breakdown;
    },
    { F1: 0, F2: 0 },
  );
  const referenceSummary = await getDashboardSummary(database, userId);
  const summary = {
    ...referenceSummary,
    totalStockUnits: rows.reduce((total, row) => total + row.quantity, 0),
    stockLineCount: rows.length,
    trackedItems: itemCodes.size,
    formularyBreakdown,
    recentStock: rows.slice(0, 5),
  };
  res.json(GetDashboardResponse.parse(summary));
});

router.get("/stock", authMiddleware, async (req, res): Promise<void> => {
  const exposure = await getUserExposure(req.userId!);
  res.json(ListStockResponse.parse(exposure));
});

router.post("/stock", authMiddleware, async (req, res): Promise<void> => {
  const parsed = CreateStockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [item] = await database
    .select({ itemCode: pbsItemsTable.itemCode })
    .from(pbsItemsTable)
    .where(eq(pbsItemsTable.itemCode, parsed.data.itemCode));
  if (!item) {
    res.status(400).json({ error: "PBS item code not found" });
    return;
  }
  const [created] = await database
    .insert(pharmacyStockTable)
    .values({
      ...parsed.data,
      userId: req.userId!,
      purchaseDate: parsed.data.purchaseDate.toISOString().slice(0, 10),
      invoiceReference: parsed.data.invoiceReference?.trim() || null,
    })
    .returning({ id: pharmacyStockTable.id });
  const [row] = await database
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(and(eq(pharmacyStockTable.id, created.id), eq(pharmacyStockTable.userId, req.userId!)));
  res.status(201).json(CreateStockResponse.parse(row));
});

router.patch("/stock/:id", authMiddleware, async (req, res): Promise<void> => {
  const params = UpdateStockParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateStockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.itemCode) {
    const [item] = await database
      .select({ itemCode: pbsItemsTable.itemCode })
      .from(pbsItemsTable)
      .where(eq(pbsItemsTable.itemCode, parsed.data.itemCode));
    if (!item) {
      res.status(400).json({ error: "PBS item code not found" });
      return;
    }
  }
  const updateData = {
    ...(parsed.data.itemCode !== undefined ? { itemCode: parsed.data.itemCode } : {}),
    ...(parsed.data.quantity !== undefined ? { quantity: parsed.data.quantity } : {}),
    ...(parsed.data.purchasePrice !== undefined
      ? { purchasePrice: parsed.data.purchasePrice }
      : {}),
    ...(parsed.data.purchaseDate !== undefined
      ? { purchaseDate: parsed.data.purchaseDate.toISOString().slice(0, 10) }
      : {}),
    ...(parsed.data.invoiceReference !== undefined
      ? { invoiceReference: parsed.data.invoiceReference?.trim() || null }
      : {}),
  };
  const [updated] = await database
    .update(pharmacyStockTable)
    .set(updateData)
    .where(and(eq(pharmacyStockTable.id, params.data.id), eq(pharmacyStockTable.userId, req.userId!)))
    .returning({ id: pharmacyStockTable.id });
  if (!updated) {
    res.status(404).json({ error: "Stock record not found" });
    return;
  }
  const [row] = await database
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(and(eq(pharmacyStockTable.id, updated.id), eq(pharmacyStockTable.userId, req.userId!)));
  res.json(UpdateStockResponse.parse(row));
});

router.delete("/stock/:id", authMiddleware, async (req, res): Promise<void> => {
  const params = DeleteStockParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await database
    .delete(pharmacyStockTable)
    .where(and(eq(pharmacyStockTable.id, params.data.id), eq(pharmacyStockTable.userId, req.userId!)))
    .returning({ id: pharmacyStockTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Stock record not found" });
    return;
  }
  res.sendStatus(204);
});

  return router;
}

export default createStockRouter();