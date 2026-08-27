import { db, drugsTable, pbsItemsTable, priceHistoryTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { recalculatePredictedReductionsForDrug } from "./predicted-reductions";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsFromPayload(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

  for (const key of ["data", "items", "results", "records"]) {
    if (Array.isArray(payload[key])) return payload[key].filter(isRecord);
  }
  return [];
}

export function itemIdsFromAtcRelationshipPayload(payload: unknown): string[] {
  return recordsFromPayload(payload)
    .map((record) => stringField(record, "li_item_id"))
    .filter((itemId): itemId is string => Boolean(itemId));
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

function dateField(record: JsonRecord, ...keys: string[]): string | undefined {
  const value = stringField(record, ...keys);
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function strengthField(record: JsonRecord): string | undefined {
  const explicit = stringField(record, "strength", "li_strength");
  if (explicit) return explicit;
  const form = stringField(record, "li_form", "schedule_form");
  return form?.match(/\b\d+(?:\.\d+)?\s*(?:micrograms?|mcg|mg|g|kg|mL|ml|%|IU)\b/i)?.[0];
}

function formField(record: JsonRecord): string | undefined {
  const explicit = stringField(record, "form");
  if (explicit) return explicit;
  const source = stringField(record, "li_form", "schedule_form");
  if (!source) return undefined;
  return source.split(/\s+containing\s+/i)[0]?.trim() || source;
}

function itemFormulary(record: JsonRecord): "F1" | "F2" | undefined {
  const value = stringField(record, "formulary");
  return value === "F1" || value === "F2" ? value : undefined;
}

async function resolveDrugId(input: {
  name: string;
  activeIngredient: string;
  sponsor: string;
  firstPbsListingDate: string;
}): Promise<number> {
  const [existing] = await db
    .select({
      id: drugsTable.id,
      firstPbsListingDate: drugsTable.firstPbsListingDate,
    })
    .from(drugsTable)
    .where(eq(drugsTable.activeIngredient, input.activeIngredient))
    .limit(1);
  if (existing) {
    await db
      .update(drugsTable)
      .set({
        ...input,
        firstPbsListingDate:
          existing.firstPbsListingDate <= input.firstPbsListingDate
            ? existing.firstPbsListingDate
            : input.firstPbsListingDate,
      })
      .where(eq(drugsTable.id, existing.id));
    return existing.id;
  }

  // Ingestion runs are mutually exclusive. Reserve IDs above the manually seeded
  // range while keeping the existing integer key compatible with the database.
  const [latest] = await db
    .select({ id: sql<number>`coalesce(max(${drugsTable.id}), 999_999)` })
    .from(drugsTable);
  const [created] = await db
    .insert(drugsTable)
    .values({ ...input, id: (latest?.id ?? 999_999) + 1 })
    .onConflictDoNothing()
    .returning({ id: drugsTable.id });
  if (!created) throw new Error("Could not create PBS drug reference");
  return created.id;
}

async function appendPriceHistoryIfChanged(input: {
  itemCode: string;
  scheduleCode: number;
  scheduleEffectiveDate: string;
  determinedPrice: number;
}): Promise<boolean> {
  const [sameSchedule] = await db
    .select({ aemp: priceHistoryTable.aemp })
    .from(priceHistoryTable)
    .where(
      and(
        eq(priceHistoryTable.itemCode, input.itemCode),
        eq(priceHistoryTable.scheduleEffectiveDate, input.scheduleEffectiveDate),
      ),
    )
    .orderBy(desc(priceHistoryTable.id))
    .limit(1);
  const [previous] = await db
    .select({ aemp: priceHistoryTable.aemp })
    .from(priceHistoryTable)
    .where(
      and(
        eq(priceHistoryTable.itemCode, input.itemCode),
        lt(priceHistoryTable.scheduleEffectiveDate, input.scheduleEffectiveDate),
      ),
    )
    .orderBy(desc(priceHistoryTable.scheduleEffectiveDate), desc(priceHistoryTable.id))
    .limit(1);
  const shouldInsert =
    sameSchedule?.aemp !== input.determinedPrice &&
    previous?.aemp !== input.determinedPrice;

  if (shouldInsert) {
    await db.insert(priceHistoryTable).values({
      itemCode: input.itemCode,
      priceDate: input.scheduleEffectiveDate,
      scheduleCode: input.scheduleCode,
      scheduleEffectiveDate: input.scheduleEffectiveDate,
      aemp: input.determinedPrice,
      dpmq: null,
      reductionType: null,
    });
  }

  const chronologicalRows = await db
    .select({
      id: priceHistoryTable.id,
      aemp: priceHistoryTable.aemp,
    })
    .from(priceHistoryTable)
    .where(eq(priceHistoryTable.itemCode, input.itemCode))
    .orderBy(asc(priceHistoryTable.scheduleEffectiveDate), asc(priceHistoryTable.id));
  const redundantIds: number[] = [];
  let previousPrice: number | undefined;
  for (const row of chronologicalRows) {
    if (previousPrice === row.aemp) {
      redundantIds.push(row.id);
    } else {
      previousPrice = row.aemp;
    }
  }
  if (redundantIds.length > 0) {
    await db.delete(priceHistoryTable).where(inArray(priceHistoryTable.id, redundantIds));
  }
  return shouldInsert;
}

/**
 * Converts one untouched /items response page into reference rows.
 *
 * Items outside the existing F1/F2 reference-directory scope, or rows missing
 * an identifier and current pricing values, remain in raw staging for audit
 * rather than being converted into incomplete public reference rows.
 */
export async function upsertPbsItemsFromPayload(
  payload: unknown,
  scheduleDate: string,
  scheduleEffectiveDate = scheduleDate,
  options: { scheduleCode?: number; updateCurrentItem?: boolean } = {},
): Promise<number> {
  let processed = 0;
  const affectedDrugIds = new Set<number>();
  const updateCurrentItem = options.updateCurrentItem ?? true;

  for (const record of recordsFromPayload(payload)) {
    const liItemId = stringField(record, "li_item_id");
    const pbsCode = stringField(record, "pbs_code");
    const activeIngredient = stringField(record, "active_ingredient", "li_drug_name", "drug_name");
    const drugName = activeIngredient;
    const brandName = stringField(record, "brand_name") ?? drugName;
    const formulary = itemFormulary(record);
    const scheduleCode = options.scheduleCode ?? numberField(record, "schedule_code");
    const determinedPrice = numberField(record, "determined_price", "aemp", "current_aemp");
    const dispensedPrice = numberField(record, "dispensed_price", "dpmq", "current_dpmq");

    if (
      !liItemId ||
      !pbsCode ||
      !drugName ||
      !brandName ||
      !formulary ||
      scheduleCode === undefined ||
      determinedPrice === undefined
    ) {
      continue;
    }
    const itemCode = liItemId;

    const firstListedDate = dateField(record, "first_listed_date") ?? scheduleDate;
    const sponsor = stringField(record, "manufacturer_code", "organisation_id") ?? "PBS";
    const drugId = await resolveDrugId({
      name: drugName,
      activeIngredient,
      sponsor,
      firstPbsListingDate: firstListedDate,
    });

    const itemValues = {
        itemCode,
        pbsCode,
        liItemId,
        scheduleCode,
        drugId,
        brandName,
        strength: strengthField(record),
        form: formField(record),
        packSize: stringField(record, "pack_size", "pack_quantity", "number_of_containers"),
        pricingQuantity: numberField(record, "pricing_quantity"),
        benefitTypeCode: stringField(record, "benefit_type_code"),
        maximumQuantityUnits: numberField(record, "maximum_quantity_units"),
        liForm: stringField(record, "li_form"),
        programCode: stringField(record, "program_code"),
        formulary,
        currentAemp: determinedPrice,
        currentDpmq: dispensedPrice ?? null,
        lastUpdated: scheduleDate,
        firstListedDate: dateField(record, "first_listed_date"),
        weightedAvgDisclosedPrice: numberField(record, "weighted_avg_disclosed_price"),
        originatorBrandIndicator: stringField(record, "originator_brand_indicator"),
        brandSubstitutionGroupId: stringField(record, "brand_substitution_group_id"),
        advancedNoticeDate: dateField(record, "advanced_notice_date"),
        nonEffectiveDate: dateField(record, "non_effective_date"),
        determinedPrice,
        claimedPrice: numberField(record, "claimed_price"),
        proportionalPrice: numberField(record, "proportional_price"),
        therapeuticGroupId: stringField(record, "therapeutic_group_id"),
        innovatorIndicator: stringField(record, "innovator_indicator"),
      };
    if (updateCurrentItem) {
      await db
        .insert(pbsItemsTable)
        .values(itemValues)
        .onConflictDoUpdate({
          target: pbsItemsTable.itemCode,
          set: itemValues,
        });
    } else {
      await db.insert(pbsItemsTable).values(itemValues).onConflictDoNothing();
    }

    await appendPriceHistoryIfChanged({
      itemCode,
      scheduleCode,
      scheduleEffectiveDate,
      determinedPrice,
    });
    affectedDrugIds.add(drugId);
    processed += 1;
  }

  for (const drugId of affectedDrugIds) {
    await recalculatePredictedReductionsForDrug(drugId);
  }
  return processed;
}