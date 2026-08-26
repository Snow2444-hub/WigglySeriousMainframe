import { and, asc, desc, eq, gte, ilike, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  artgEntriesTable,
  drugsTable,
  pbsItemsTable,
  predictedReductionsTable,
  priceHistoryTable,
  scheduleChangesTable,
} from "@workspace/db";
import {
  GetDrugScheduleTimelineParams,
  GetDrugScheduleTimelineResponse,
  GetDrugParams,
  GetDrugResponse,
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
  ListItemPredictedReductionsParams,
  ListItemPredictedReductionsResponse,
  ListItemScheduleChangesParams,
  ListItemScheduleChangesResponse,
  ListPriceHistoryParams,
  ListPriceHistoryResponse,
  ListScheduleChangesQueryParams,
  ListScheduleChangesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

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
  return /^crosuva\s+(10|20|40)$/.test(normalized) ? "crosuva" : normalized;
}

function brandGroupName(brandName: string): string {
  return brandGroupKey(brandName) === "crosuva" ? "Crosuva" : brandName;
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
  const [items, predictions, highChanges] = await Promise.all([
    db.select(pbsSelect).from(pbsItemsTable).innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id)),
    db
      .select({
        drugId: predictedReductionsTable.drugId,
        predictedDate: predictedReductionsTable.predictedDate,
        reductionType: predictedReductionsTable.reductionType,
        predictedPercentage: predictedReductionsTable.predictedPercentage,
      })
      .from(predictedReductionsTable)
      .where(gte(predictedReductionsTable.predictedDate, today)),
    db
      .select({ drugId: scheduleChangesTable.drugId })
      .from(scheduleChangesTable)
      .where(
        and(
          eq(scheduleChangesTable.significance, "high"),
          gte(scheduleChangesTable.effectiveDate, recentDateString),
        ),
      ),
  ]);
  const grouped = new Map<number, typeof items>();
  for (const item of items) {
    const group = grouped.get(item.drugId) ?? [];
    group.push(item);
    grouped.set(item.drugId, group);
  }
  const search = parsed.data.search?.trim().toLowerCase();
  const summaries = [...grouped.entries()].flatMap(([drugId, group]) => {
    const first = group[0];
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
        activeIngredient: first.activeIngredient,
        brandCount: new Set(group.map((item) => brandGroupKey(item.brandName))).size,
        itemCount: group.length,
        formulary: summarizedFormulary(group.map((item) => item.formulary)),
        ...priceRange(group.map((item) => item.currentAemp)),
        upcomingPredictedReductionCount: upcoming.length,
        nextPredictedReductionDate: upcoming[0]?.predictedDate ?? null,
         nextPredictedReductionType: upcoming[0]?.reductionType ?? null,
         nextPredictedReductionPercentage: upcoming[0]?.predictedPercentage ?? null,
        recentHighChangeCount: highChanges.filter((change) => change.drugId === drugId).length,
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
  const [items, changes] = await Promise.all([
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
  ]);
  const grouped = new Map<string, typeof items>();
  for (const item of items) {
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
  const rows = await db
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
    .orderBy(asc(pbsItemsTable.itemCode));
  res.json(ListMedicineBrandItemsResponse.parse(rows));
});

router.get("/pbs-items", async (req, res): Promise<void> => {
  const parsed = ListPbsItemsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, formulary, limit = 50 } = parsed.data;
  const rows = await db
    .select(pbsSelect)
    .from(pbsItemsTable)
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(
      and(
        formulary ? eq(pbsItemsTable.formulary, formulary) : undefined,
        search
          ? or(
              ilike(pbsItemsTable.itemCode, `%${search}%`),
              ilike(pbsItemsTable.brandName, `%${search}%`),
              ilike(drugsTable.name, `%${search}%`),
              ilike(drugsTable.activeIngredient, `%${search}%`),
            )
          : undefined,
      ),
    )
    .orderBy(asc(pbsItemsTable.brandName))
    .limit(limit);
  res.json(ListPbsItemsResponse.parse(rows));
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
  res.json(GetPbsItemResponse.parse(row));
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

router.get("/pbs-items/:itemCode/predicted-reductions", async (req, res): Promise<void> => {
  const parsed = ListItemPredictedReductionsParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(predictedReductionsTable)
    .where(eq(predictedReductionsTable.itemCode, parsed.data.itemCode))
    .orderBy(asc(predictedReductionsTable.predictedDate));
  res.json(ListItemPredictedReductionsResponse.parse(rows));
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
  significance: scheduleChangesTable.significance,
  notes: scheduleChangesTable.notes,
  createdAt: scheduleChangesTable.createdAt,
};

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
      ),
    )
    .orderBy(desc(scheduleChangesTable.effectiveDate), desc(scheduleChangesTable.id));
  res.json(ListItemScheduleChangesResponse.parse(rows));
});

router.get("/schedule-changes", async (req, res): Promise<void> => {
  const parsed = ListScheduleChangesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { drugId, changeType, significance, limit = 200 } = parsed.data;
  const rows = await db
    .select(scheduleChangeSelect)
    .from(scheduleChangesTable)
    .innerJoin(drugsTable, eq(scheduleChangesTable.drugId, drugsTable.id))
    .where(
      and(
        drugId ? eq(scheduleChangesTable.drugId, drugId) : undefined,
        changeType ? eq(scheduleChangesTable.changeType, changeType) : undefined,
        significance ? eq(scheduleChangesTable.significance, significance) : undefined,
      ),
    )
    .orderBy(desc(scheduleChangesTable.effectiveDate), desc(scheduleChangesTable.id))
    .limit(limit);
  res.json(ListScheduleChangesResponse.parse(rows));
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
  res.json(GetDrugScheduleTimelineResponse.parse(rows));
});

router.get("/artg-entries", async (req, res): Promise<void> => {
  const parsed = ListArtgEntriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, status } = parsed.data;
  const rows = await db
    .select()
    .from(artgEntriesTable)
    .where(
      and(
        status ? eq(artgEntriesTable.status, status) : undefined,
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
    .orderBy(asc(artgEntriesTable.productName));
  res.json(ListArtgEntriesResponse.parse(rows));
});

export default router;