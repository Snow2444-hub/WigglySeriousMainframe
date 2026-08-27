import { and, eq } from "drizzle-orm";
import { db, pharmacyBrandPreferencesTable } from "@workspace/db";

export function brandPreferenceKey(drugId: number, brandName: string): string {
  return `${drugId}:${normalizeBrandName(brandName)}`;
}

export function normalizeBrandName(brandName: string): string {
  const normalized = brandName.trim().toLocaleLowerCase();
  if (/^crosuva(?:\s+(5|10|20|40))?$/.test(normalized)) return "crosuva";
  if (/^pharmacor\s+rosuvastatin\s+(5|10|20|40)$/.test(normalized)) return "pharmacor rosuvastatin";
  return normalized;
}

export function displayBrandName(brandName: string): string {
  const normalized = normalizeBrandName(brandName);
  if (normalized === "crosuva") return "Crosuva";
  if (normalized === "pharmacor rosuvastatin") return "Pharmacor Rosuvastatin";
  return brandName;
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