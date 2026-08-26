import {
  db,
  drugsTable,
  pbsItemsTable,
  predictedReductionsTable,
  reductionSettingsTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

const DEFAULT_SETTINGS = [
  { anniversaryYears: 5, reductionType: "5-year statutory reduction", percentage: 5 },
  { anniversaryYears: 10, reductionType: "10-year statutory reduction", percentage: 5 },
  { anniversaryYears: 15, reductionType: "15-year statutory reduction", percentage: 26.1 },
] as const;

export async function ensureDefaultReductionSettings(): Promise<void> {
  await db.insert(reductionSettingsTable).values([...DEFAULT_SETTINGS]).onConflictDoNothing();
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
    })
    .from(pbsItemsTable)
    .where(and(eq(pbsItemsTable.drugId, drugId), eq(pbsItemsTable.formulary, "F1")));
  const settings = await db
    .select()
    .from(reductionSettingsTable)
    .orderBy(asc(reductionSettingsTable.anniversaryYears));

  await db.delete(predictedReductionsTable).where(eq(predictedReductionsTable.drugId, drugId));
  if (items.length === 0) return 0;

  const rows = settings.flatMap((setting) => {
    const predictedDate = roundedForwardToApril(drug.firstPbsListingDate, setting.anniversaryYears);
    if (predictedDate <= today) return [];
    return items.map((item) => ({
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

  if (rows.length > 0) {
    await db.insert(predictedReductionsTable).values(rows);
  }
  return rows.length;
}