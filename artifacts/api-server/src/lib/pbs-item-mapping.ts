import { db, drugsTable, pbsItemsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

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
    .select({ id: drugsTable.id })
    .from(drugsTable)
    .where(eq(drugsTable.activeIngredient, input.activeIngredient))
    .limit(1);
  if (existing) return existing.id;

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

/**
 * Converts one untouched /items response page into reference rows.
 *
 * Items outside the existing F1/F2 reference-directory scope, or rows missing
 * an identifier and current pricing values, remain in raw staging for audit
 * rather than being converted into incomplete public reference rows.
 */
export async function upsertPbsItemsFromPayload(payload: unknown, scheduleDate: string): Promise<number> {
  let processed = 0;

  for (const record of recordsFromPayload(payload)) {
    const liItemId = stringField(record, "li_item_id");
    const itemCode = stringField(record, "pbs_code");
    const activeIngredient = stringField(record, "active_ingredient", "li_drug_name", "drug_name");
    const drugName = activeIngredient;
    const brandName = stringField(record, "brand_name") ?? drugName;
    const formulary = itemFormulary(record);
    const determinedPrice = numberField(record, "determined_price", "aemp", "current_aemp");
    const dispensedPrice = numberField(record, "dispensed_price", "dpmq", "current_dpmq");

    if (
      !liItemId ||
      !itemCode ||
      !drugName ||
      !brandName ||
      !formulary ||
      determinedPrice === undefined
    ) {
      continue;
    }

    const firstListedDate = dateField(record, "first_listed_date") ?? scheduleDate;
    const sponsor = stringField(record, "manufacturer_code", "organisation_id") ?? "PBS";
    const drugId = await resolveDrugId({
      name: drugName,
      activeIngredient,
      sponsor,
      firstPbsListingDate: firstListedDate,
    });

    await db
      .insert(pbsItemsTable)
      .values({
        itemCode,
        liItemId,
        drugId,
        brandName,
        strength: strengthField(record),
        form: formField(record),
        packSize: stringField(record, "pack_size", "pack_quantity", "number_of_containers"),
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
      })
      .onConflictDoUpdate({
        target: pbsItemsTable.itemCode,
        set: {
          liItemId,
          drugId,
          brandName,
          strength: strengthField(record),
          form: formField(record),
          packSize: stringField(record, "pack_size", "pack_quantity", "number_of_containers"),
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
        },
      });

    processed += 1;
  }

  return processed;
}