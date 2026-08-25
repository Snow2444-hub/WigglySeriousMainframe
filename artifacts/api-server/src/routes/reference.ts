import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, artgEntriesTable, drugsTable, pbsItemsTable, priceHistoryTable } from "@workspace/db";
import {
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
  ListPriceHistoryParams,
  ListPriceHistoryResponse,
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