import { and, asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  drugsTable,
  pbsItemsTable,
  pbsWatchlistTable,
  pharmacyBrandPreferencesTable,
} from "@workspace/db";
import {
  ClearPharmacyBrandPreferencesResponse,
  GetPharmacyBrandPreferencesResponse,
  SetPharmacyBrandPreferenceBody,
  SetPharmacyBrandPreferenceResponse,
  SetPharmacyBrandPreferencesBody,
  SetPharmacyBrandPreferencesResponse,
} from "@workspace/api-zod";
import {
  brandPreferenceKey,
  displayBrandName,
  getHiddenBrandKeys,
  normalizeBrandName,
} from "../lib/brand-preferences";
import { requireAuth } from "../middlewares/requireAuth";

type PreferenceCatalogueBrand = {
  drugId: number;
  drugName: string;
  brandName: string;
  brandKey: string;
  itemCount: number;
  isInnovator: boolean;
};

function watchlistMatches(
  item: {
    drugName: string;
    brandName: string;
    pbsCode: string | null;
    formulary: string;
    programCode: string | null;
  },
  entry: { filterType: string; filterValue: string },
): boolean {
  const value = entry.filterValue.trim().toLocaleLowerCase();
  if (!value) return false;
  if (entry.filterType === "drug_name") return item.drugName.toLocaleLowerCase().includes(value);
  if (entry.filterType === "brand_name") return item.brandName.toLocaleLowerCase().includes(value);
  if (entry.filterType === "pbs_code") return item.pbsCode?.toLocaleLowerCase().includes(value) ?? false;
  if (entry.filterType === "formulary") return item.formulary.toLocaleLowerCase() === value;
  if (entry.filterType === "program_code") return item.programCode?.toLocaleLowerCase() === value;
  return false;
}

async function getPreferenceCatalogue(): Promise<PreferenceCatalogueBrand[]> {
  const [watchlist, items] = await Promise.all([
    db
      .select({
        filterType: pbsWatchlistTable.filterType,
        filterValue: pbsWatchlistTable.filterValue,
      })
      .from(pbsWatchlistTable)
      .where(eq(pbsWatchlistTable.enabled, true)),
    db
      .select({
        drugId: pbsItemsTable.drugId,
        drugName: drugsTable.name,
        brandName: pbsItemsTable.brandName,
        pbsCode: pbsItemsTable.pbsCode,
        formulary: pbsItemsTable.formulary,
        programCode: pbsItemsTable.programCode,
        innovatorIndicator: pbsItemsTable.innovatorIndicator,
      })
      .from(pbsItemsTable)
      .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id)),
  ]);
  const brands = new Map<string, PreferenceCatalogueBrand>();
  for (const item of items) {
    if (!watchlist.some((entry) => watchlistMatches(item, entry))) continue;
    const brandKey = normalizeBrandName(item.brandName);
    const key = `${item.drugId}:${brandKey}`;
    const brand = brands.get(key) ?? {
      drugId: item.drugId,
      drugName: item.drugName,
      brandName: displayBrandName(item.brandName),
      brandKey,
      itemCount: 0,
      isInnovator: false,
    };
    brand.itemCount += 1;
    if (item.innovatorIndicator && !["n", "no", "false", "0"].includes(item.innovatorIndicator.trim().toLowerCase())) {
      brand.isInnovator = true;
    }
    brands.set(key, brand);
  }
  return [...brands.values()].sort(
    (left, right) => left.drugName.localeCompare(right.drugName) || left.brandName.localeCompare(right.brandName),
  );
}

async function getPreferenceSummary(userId: string) {
  const [catalogue, hiddenBrandKeys] = await Promise.all([
    getPreferenceCatalogue(),
    getHiddenBrandKeys(userId),
  ]);
  const brands = catalogue.map((brand) => ({
    drugId: brand.drugId,
    drugName: brand.drugName,
    brandName: brand.brandName,
    itemCount: brand.itemCount,
    hidden: hiddenBrandKeys.has(brandPreferenceKey(brand.drugId, brand.brandName)),
    isInnovator: brand.isInnovator,
  }));
  const hiddenBrands = brands.filter((brand) => brand.hidden);
  return {
    hiddenBrandCount: hiddenBrands.length,
    hiddenItemCount: hiddenBrands.reduce((count, brand) => count + brand.itemCount, 0),
    brands,
  };
}

const router: IRouter = Router();

router.use(requireAuth);

router.get("/pharmacy-brand-preferences", async (req, res): Promise<void> => {
  res.json(GetPharmacyBrandPreferencesResponse.parse(await getPreferenceSummary(req.userId as string)));
});

router.put("/pharmacy-brand-preferences", async (req, res): Promise<void> => {
  const parsed = SetPharmacyBrandPreferenceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const brandKey = normalizeBrandName(parsed.data.brandName);
  const catalogue = await getPreferenceCatalogue();
  const selectedBrand = catalogue.find(
    (brand) => brand.drugId === parsed.data.drugId && brand.brandKey === brandKey,
  );
  if (!selectedBrand) {
    res.status(400).json({ error: "Choose a brand from the pharmacy's watchlisted medicines." });
    return;
  }

  await db
    .insert(pharmacyBrandPreferencesTable)
    .values({
      userId: req.userId as string,
      drugId: selectedBrand.drugId,
      brandKey: selectedBrand.brandKey,
      brandName: selectedBrand.brandName,
      hidden: parsed.data.hidden,
    })
    .onConflictDoUpdate({
      target: [
        pharmacyBrandPreferencesTable.userId,
        pharmacyBrandPreferencesTable.drugId,
        pharmacyBrandPreferencesTable.brandKey,
      ],
      set: {
        brandName: selectedBrand.brandName,
        hidden: parsed.data.hidden,
      },
    });
  res.json(SetPharmacyBrandPreferenceResponse.parse(await getPreferenceSummary(req.userId as string)));
});

router.put("/pharmacy-brand-preferences/bulk", async (req, res): Promise<void> => {
  const parsed = SetPharmacyBrandPreferencesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const catalogue = await getPreferenceCatalogue();
  const selected = parsed.data.preferences.map((preference) => {
    const brandKey = normalizeBrandName(preference.brandName);
    return catalogue.find((brand) => brand.drugId === preference.drugId && brand.brandKey === brandKey);
  });
  if (selected.some((brand) => !brand)) {
    res.status(400).json({ error: "Choose brands from the pharmacy's watchlisted medicines." });
    return;
  }
  await db.transaction(async (tx) => {
    for (const [index, brand] of selected.entries()) {
      const preference = parsed.data.preferences[index];
      if (!brand || !preference) continue;
      await tx
        .insert(pharmacyBrandPreferencesTable)
        .values({
          userId: req.userId as string,
          drugId: brand.drugId,
          brandKey: brand.brandKey,
          brandName: brand.brandName,
          hidden: preference.hidden,
        })
        .onConflictDoUpdate({
          target: [
            pharmacyBrandPreferencesTable.userId,
            pharmacyBrandPreferencesTable.drugId,
            pharmacyBrandPreferencesTable.brandKey,
          ],
          set: {
            brandName: brand.brandName,
            hidden: preference.hidden,
          },
        });
    }
  });
  res.json(SetPharmacyBrandPreferencesResponse.parse(await getPreferenceSummary(req.userId as string)));
});

router.delete("/pharmacy-brand-preferences", async (req, res): Promise<void> => {
  await db
    .delete(pharmacyBrandPreferencesTable)
    .where(eq(pharmacyBrandPreferencesTable.userId, req.userId as string));
  res.status(204).send(ClearPharmacyBrandPreferencesResponse.parse(undefined));
});

export default router;