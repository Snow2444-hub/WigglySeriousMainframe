import { and, eq } from "drizzle-orm";
import { db, pharmacyBrandPreferencesTable } from "@workspace/db";

export function brandPreferenceKey(drugId: number, brandName: string): string {
  return `${drugId}:${normalizeBrandName(brandName)}`;
}

export function normalizeBrandName(brandName: string): string {
  const normalized = brandName.trim().toLocaleLowerCase();
  return /^crosuva\s+(10|20|40)$/.test(normalized) ? "crosuva" : normalized;
}

export function displayBrandName(brandName: string): string {
  return normalizeBrandName(brandName) === "crosuva" ? "Crosuva" : brandName;
}

export async function getHiddenBrandKeys(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      drugId: pharmacyBrandPreferencesTable.drugId,
      brandKey: pharmacyBrandPreferencesTable.brandKey,
    })
    .from(pharmacyBrandPreferencesTable)
    .where(
      and(
        eq(pharmacyBrandPreferencesTable.userId, userId),
        eq(pharmacyBrandPreferencesTable.hidden, true),
      ),
    );
  return new Set(rows.map((row) => `${row.drugId}:${row.brandKey}`));
}

export function isBrandHidden(
  hiddenBrandKeys: Set<string>,
  drugId: number,
  brandName: string | null,
): boolean {
  return Boolean(brandName && hiddenBrandKeys.has(brandPreferenceKey(drugId, brandName)));
}