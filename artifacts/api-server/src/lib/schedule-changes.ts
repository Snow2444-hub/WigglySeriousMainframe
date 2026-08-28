import {
  db,
  drugsTable,
  pbsItemPremiumHistoryTable,
  rawScheduleStagingTable,
  reductionSettingsTable,
  type ScheduleChangeAffectedItem,
  scheduleChangesTable,
  scheduleChangeSettingsTable,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { recalculatePredictedReductionsForDrug } from "./predicted-reductions";

type JsonRecord = Record<string, unknown>;

type PremiumRuleSnapshot = {
  dispensingRuleReference: string;
  dispensingRuleMnemonic: string | null;
  brandPremium: number | null;
  therapeuticGroupPremium: number | null;
  therapeuticExemptionIndicator: string | null;
};

export type ListingAmendmentFieldKey =
  | "benefit_type"
  | "maximum_quantity"
  | "maximum_prescribable_packs"
  | "number_of_repeats"
  | "pack_size"
  | "restriction_indicators"
  | "caution_indicators";

type ListingAmendmentField = {
  key: ListingAmendmentFieldKey;
  label: string;
  keys: string[];
  numeric?: boolean;
  composite?: boolean;
};

const LISTING_AMENDMENT_FIELDS: ListingAmendmentField[] = [
  {
    key: "benefit_type",
    label: "benefit type",
    keys: ["benefit_type_code", "benefit_type", "benefit_type_description"],
  },
  {
    key: "maximum_quantity",
    label: "maximum quantity",
    keys: ["maximum_quantity_units", "maximum_quantity", "maximum_quantity_per_pack"],
    numeric: true,
  },
  {
    key: "maximum_prescribable_packs",
    label: "maximum prescribable packs",
    keys: [
      "maximum_prescribable_packs",
      "max_prescribable_packs",
      "maximum_prescribable_pack",
      "maximum_number_of_packs",
      "maximum_packs",
      "max_number_of_packs",
    ],
    numeric: true,
  },
  {
    key: "number_of_repeats",
    label: "number of repeats",
    keys: ["number_of_repeats", "number_repeats", "repeats", "repeat_count", "maximum_repeats"],
    numeric: true,
  },
  {
    key: "pack_size",
    label: "pack size",
    keys: ["pack_size", "pack_quantity", "number_of_containers"],
  },
  {
    key: "restriction_indicators",
    label: "restriction indicators",
    keys: [
      "restriction_indicators",
      "restriction_indicator",
      "restriction_codes",
      "restriction_code",
      "note_indicator",
      "legal_car_ind",
      "legal_unar_ind",
    ],
    composite: true,
  },
  {
    key: "caution_indicators",
    label: "caution indicators",
    keys: ["caution_indicators", "caution_indicator", "caution_codes", "caution_code", "cautions"],
    composite: true,
  },
];

export type SnapshotItem = {
  liItemId: string;
  pbsCode: string | null;
  drugKey: string;
  brandName: string;
  strength: string | null;
  determinedPrice: number | null;
  formulary: "F1" | "F2" | null;
  listingFields: Record<ListingAmendmentFieldKey, unknown>;
  premiumRules: PremiumRuleSnapshot[];
};

export type ScheduleSnapshot = {
  scheduleCode: number;
  effectiveDate: string;
  drugs: Map<string, Map<string, SnapshotItem>>;
};

export type PriceChangeThresholds = {
  mediumReductionPercentage: number;
  highReductionPercentage: number;
  firstNewBrandHighSignificance: boolean;
  firstNewBrandReductionPercentage: number;
};

const PRICE_CHANGE_SETTING_KEY = "price-change-significance";
const DEFAULT_PRICE_CHANGE_THRESHOLDS: PriceChangeThresholds = {
  mediumReductionPercentage: 10,
  highReductionPercentage: 20,
  firstNewBrandHighSignificance: true,
  firstNewBrandReductionPercentage: 25,
};

export async function ensureDefaultScheduleChangeSettings(): Promise<void> {
  await db
    .insert(scheduleChangeSettingsTable)
    .values({ settingKey: PRICE_CHANGE_SETTING_KEY, ...DEFAULT_PRICE_CHANGE_THRESHOLDS })
    .onConflictDoNothing();
}

export async function getPriceChangeThresholds(): Promise<PriceChangeThresholds> {
  await ensureDefaultScheduleChangeSettings();
  const [settings] = await db
    .select({
      mediumReductionPercentage: scheduleChangeSettingsTable.mediumReductionPercentage,
      highReductionPercentage: scheduleChangeSettingsTable.highReductionPercentage,
      firstNewBrandHighSignificance: scheduleChangeSettingsTable.firstNewBrandHighSignificance,
    })
    .from(scheduleChangeSettingsTable)
    .where(eq(scheduleChangeSettingsTable.settingKey, PRICE_CHANGE_SETTING_KEY))
    .limit(1);
  const [firstNewBrandSetting] = await db
    .select({ percentage: reductionSettingsTable.percentage })
    .from(reductionSettingsTable)
    .where(eq(reductionSettingsTable.anniversaryYears, 0))
    .limit(1);
  return {
    ...(settings ?? DEFAULT_PRICE_CHANGE_THRESHOLDS),
    firstNewBrandReductionPercentage:
      firstNewBrandSetting?.percentage ?? DEFAULT_PRICE_CHANGE_THRESHOLDS.firstNewBrandReductionPercentage,
  };
}

export function priceChangeSignificance(
  percentageChange: number | null,
  thresholds: PriceChangeThresholds,
): "normal" | "medium" | "high" {
  if (percentageChange === null || percentageChange >= 0) return "normal";
  const reductionMagnitude = Math.abs(percentageChange);
  if (reductionMagnitude > thresholds.highReductionPercentage) return "high";
  if (reductionMagnitude > thresholds.mediumReductionPercentage) return "medium";
  return "normal";
}

function percentageFromValue(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const percentage = (value as Record<string, unknown>).percentage_change;
  return typeof percentage === "number" && Number.isFinite(percentage) ? percentage : null;
}

export async function recalculatePriceChangeSignificance(): Promise<number> {
  const [thresholds, changes] = await Promise.all([
    getPriceChangeThresholds(),
    db
      .select({
        id: scheduleChangesTable.id,
        newValue: scheduleChangesTable.newValue,
        significance: scheduleChangesTable.significance,
      })
      .from(scheduleChangesTable)
      .where(eq(scheduleChangesTable.changeType, "price_change")),
  ]);
  let updated = 0;
  for (const change of changes) {
    const significance = priceChangeSignificance(percentageFromValue(change.newValue), thresholds);
    if (significance === change.significance) continue;
    await db
      .update(scheduleChangesTable)
      .set({ significance })
      .where(eq(scheduleChangesTable.id, change.id));
    updated += 1;
  }
  return updated;
}

export async function updatePriceChangeThresholds(
  thresholds: Pick<PriceChangeThresholds, "mediumReductionPercentage" | "highReductionPercentage"> & {
    firstNewBrandHighSignificance?: boolean;
    firstNewBrandReductionPercentage?: number;
  },
): Promise<PriceChangeThresholds> {
  const current = await getPriceChangeThresholds();
  const next = { ...current, ...thresholds };
  const { firstNewBrandReductionPercentage, ...scheduleChangeValues } = next;
  await db
    .insert(scheduleChangeSettingsTable)
    .values({
      settingKey: PRICE_CHANGE_SETTING_KEY,
      ...scheduleChangeValues,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: scheduleChangeSettingsTable.settingKey,
      set: { ...scheduleChangeValues, updatedAt: new Date() },
    });
  await db
    .insert(reductionSettingsTable)
    .values({
      anniversaryYears: 0,
      reductionType: "First New Brand statutory reduction",
      percentage: firstNewBrandReductionPercentage,
      triggerType: "first_new_brand",
      subjectToMinisterialDiscretion: true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: reductionSettingsTable.anniversaryYears,
      set: {
        percentage: firstNewBrandReductionPercentage,
        triggerType: "first_new_brand",
        subjectToMinisterialDiscretion: true,
        updatedAt: new Date(),
      },
    });
  await recalculatePriceChangeSignificance();
  await recalculateNewBrandSignificance();
  return getPriceChangeThresholds();
}

export async function recalculateNewBrandSignificance(): Promise<number> {
  const settings = await getPriceChangeThresholds();
  const changes = await db
    .select({
      id: scheduleChangesTable.id,
      drugId: scheduleChangesTable.drugId,
      oldValue: scheduleChangesTable.oldValue,
      significance: scheduleChangesTable.significance,
    })
    .from(scheduleChangesTable)
    .where(eq(scheduleChangesTable.changeType, "new_brand"));

  const affectedDrugIds = new Set<number>();
  let updated = 0;
  for (const change of changes) {
    const oldValue = isRecord(change.oldValue) ? change.oldValue : {};
    const brands = Array.isArray(oldValue.brands)
      ? oldValue.brands.filter((brand): brand is string => typeof brand === "string")
      : [];
    const significance =
      settings.firstNewBrandHighSignificance && new Set(brands.map(normalized)).size === 1
        ? "high"
        : "normal";
    if (significance === change.significance) continue;
    await db.update(scheduleChangesTable).set({ significance }).where(eq(scheduleChangesTable.id, change.id));
    affectedDrugIds.add(change.drugId);
    updated += 1;
  }
  await Promise.all([...affectedDrugIds].map((drugId) => recalculatePredictedReductionsForDrug(drugId)));
  return updated;
}

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

function valueField(record: JsonRecord, keys: string[], numeric = false): unknown {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === null || value === undefined) return null;
    if (numeric) {
      const number = numberField(record, key);
      return number ?? null;
    }
    if (typeof value === "string") return value.trim() || null;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value;
    if (isRecord(value)) return value;
    return String(value);
  }
  return null;
}

function listingFieldValues(record: JsonRecord): Record<ListingAmendmentFieldKey, unknown> {
  return Object.fromEntries(
    LISTING_AMENDMENT_FIELDS.map((field) => [
      field.key,
      field.composite
        ? Object.fromEntries(
            field.keys
              .filter((key) => key in record)
              .map((key) => [key, valueField(record, [key])]),
          )
        : valueField(record, field.keys, field.numeric),
    ]),
  ) as Record<ListingAmendmentFieldKey, unknown>;
}

function comparableValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (Array.isArray(value)) return value.map(comparableValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, comparableValue(entry)]),
    );
  }
  return value;
}

function valueFingerprint(value: unknown): string {
  return JSON.stringify(comparableValue(value));
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function scheduleCodeFromRequestKey(requestKey: string): number | undefined {
  const match = requestKey.match(/schedule-(\d+)$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : undefined;
}

function percentChange(oldValue: number, newValue: number): number | null {
  if (oldValue === 0) return null;
  return Math.round(((newValue - oldValue) / oldValue) * 10000) / 100;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function snapshotKey(scheduleCode: number, effectiveDate: string): string {
  return `${scheduleCode}:${effectiveDate}`;
}

async function loadStagedSnapshots(): Promise<ScheduleSnapshot[]> {
  const [pages, schedulePages, premiumRows] = await Promise.all([
    db
      .select({
        id: rawScheduleStagingTable.id,
        endpoint: rawScheduleStagingTable.endpoint,
        requestKey: rawScheduleStagingTable.requestKey,
        payload: rawScheduleStagingTable.payload,
      })
      .from(rawScheduleStagingTable)
      .where(eq(rawScheduleStagingTable.endpoint, "items"))
      .orderBy(asc(rawScheduleStagingTable.id)),
    db
      .select({
        endpoint: rawScheduleStagingTable.endpoint,
        payload: rawScheduleStagingTable.payload,
      })
      .from(rawScheduleStagingTable)
      .where(eq(rawScheduleStagingTable.endpoint, "schedules"))
      .orderBy(asc(rawScheduleStagingTable.id)),
    db
      .select()
      .from(pbsItemPremiumHistoryTable)
      .orderBy(
        asc(pbsItemPremiumHistoryTable.scheduleEffectiveDate),
        asc(pbsItemPremiumHistoryTable.dispensingRuleReference),
      ),
  ]);

  const effectiveDates = new Map<number, string>();
  for (const page of schedulePages) {
    for (const record of recordsFromPayload(page.payload)) {
      const scheduleCode = numberField(record, "schedule_code");
      const effectiveDate = stringField(record, "effective_date");
      if (
        scheduleCode !== undefined &&
        /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate ?? "")
      ) {
        effectiveDates.set(scheduleCode, effectiveDate as string);
      }
    }
  }

  const snapshots = new Map<string, ScheduleSnapshot>();
  for (const page of pages) {
    for (const record of recordsFromPayload(page.payload)) {
      const scheduleCode =
        numberField(record, "schedule_code") ?? scheduleCodeFromRequestKey(page.requestKey);
      const effectiveDate =
        stringField(record, "effective_date") ??
        (scheduleCode === undefined ? undefined : effectiveDates.get(scheduleCode));
      const liItemId = stringField(record, "li_item_id");
      const drugName = stringField(record, "active_ingredient", "li_drug_name", "drug_name");
      if (
        scheduleCode === undefined ||
        !effectiveDate ||
        !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ||
        !liItemId ||
        !drugName
      ) {
        continue;
      }

      const key = snapshotKey(scheduleCode, effectiveDate);
      const snapshot = snapshots.get(key) ?? {
        scheduleCode,
        effectiveDate,
        drugs: new Map<string, Map<string, SnapshotItem>>(),
      };
      const drugKey = normalized(drugName);
      const items = snapshot.drugs.get(drugKey) ?? new Map<string, SnapshotItem>();
      items.set(liItemId, {
        liItemId,
        pbsCode: stringField(record, "pbs_code") ?? null,
        drugKey,
        brandName: stringField(record, "brand_name") ?? drugName,
        strength: stringField(record, "strength", "li_strength") ?? null,
        determinedPrice: numberField(record, "determined_price", "aemp", "current_aemp") ?? null,
        formulary:
          stringField(record, "formulary") === "F1" || stringField(record, "formulary") === "F2"
            ? (stringField(record, "formulary") as "F1" | "F2")
            : null,
        listingFields: listingFieldValues(record),
        premiumRules: [],
      });
      snapshot.drugs.set(drugKey, items);
      snapshots.set(key, snapshot);
    }
  }

  for (const row of premiumRows) {
    const snapshot = snapshots.get(snapshotKey(row.scheduleCode, row.scheduleEffectiveDate));
    if (!snapshot) continue;
    const item = [...snapshot.drugs.values()]
      .map((items) => items.get(row.liItemId))
      .find((candidate): candidate is SnapshotItem => Boolean(candidate));
    if (!item) continue;
    item.premiumRules.push({
      dispensingRuleReference: row.dispensingRuleReference,
      dispensingRuleMnemonic: row.dispensingRuleMnemonic,
      brandPremium: row.brandPremium,
      therapeuticGroupPremium: row.therapeuticGroupPremium,
      therapeuticExemptionIndicator: row.therapeuticExemptionIndicator,
    });
  }

  return [...snapshots.values()].sort((left, right) =>
    left.effectiveDate.localeCompare(right.effectiveDate),
  );
}

function hasPremium(item: SnapshotItem): boolean {
  return item.premiumRules.some(
    (rule) => (rule.brandPremium ?? 0) > 0 || (rule.therapeuticGroupPremium ?? 0) > 0,
  );
}

function premiumSnapshotValue(item: SnapshotItem) {
  const rules = [...item.premiumRules]
    .sort((left, right) => left.dispensingRuleReference.localeCompare(right.dispensingRuleReference))
    .map((rule) => ({
      dispensing_rule_reference: rule.dispensingRuleReference,
      dispensing_rule_mnem: rule.dispensingRuleMnemonic,
      brand_premium: rule.brandPremium,
      therapeutic_group_premium: rule.therapeuticGroupPremium,
      therapeutic_exemption_indicator: rule.therapeuticExemptionIndicator,
    }));
  const brandPremiums = rules
    .map((rule) => rule.brand_premium)
    .filter((value): value is number => value !== null);
  const therapeuticGroupPremiums = rules
    .map((rule) => rule.therapeutic_group_premium)
    .filter((value): value is number => value !== null);
  const exemptions = [...new Set(
    rules
      .map((rule) => rule.therapeutic_exemption_indicator)
      .filter((value): value is string => Boolean(value)),
  )];

  return {
    brand_premium: brandPremiums.length ? Math.max(...brandPremiums) : null,
    therapeutic_group_premium: therapeuticGroupPremiums.length ? Math.max(...therapeuticGroupPremiums) : null,
    therapeutic_exemption_indicator: exemptions.length === 1 ? exemptions[0] : exemptions.length ? exemptions : null,
    dispensing_rules: rules,
  };
}

function premiumFingerprint(item: SnapshotItem): string {
  return JSON.stringify(premiumSnapshotValue(item));
}

function listingSnapshotValue(item: SnapshotItem): JsonRecord {
  return {
    li_item_id: item.liItemId,
    pbs_code: item.pbsCode,
    brand_name: item.brandName,
    strength: item.strength,
    determined_price: item.determinedPrice,
    formulary: item.formulary,
    ...item.listingFields,
  };
}

function amendmentValueMap(
  item: SnapshotItem,
  fields: ListingAmendmentFieldKey[],
): JsonRecord {
  return Object.fromEntries(fields.map((field) => [field, item.listingFields[field]]));
}

function changedListingFields(
  previous: SnapshotItem,
  current: SnapshotItem,
): Array<{ field: ListingAmendmentField; previous: unknown; current: unknown }> {
  return LISTING_AMENDMENT_FIELDS.flatMap((field) => {
    const previousValue = previous.listingFields[field.key];
    const currentValue = current.listingFields[field.key];
    return valueFingerprint(previousValue) === valueFingerprint(currentValue)
      ? []
      : [{ field, previous: previousValue, current: currentValue }];
  });
}

function formatAmendmentValue(field: ListingAmendmentField, value: unknown): string {
  if (value === null || value === undefined || value === "") return "not specified";
  if (field.key === "benefit_type") {
    const normalizedValue = String(value).trim().toLowerCase();
    if (normalizedValue === "u" || normalizedValue === "unrestricted") return "unrestricted";
    if (normalizedValue === "r" || normalizedValue === "restricted") return "restricted";
    if (["a", "s", "authority", "authority required"].includes(normalizedValue)) return "authority";
  }
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ") || "none";
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

function amendmentNotes(
  changes: Array<{ field: ListingAmendmentField; previous: unknown; current: unknown }>,
): string {
  return changes
    .map(
      ({ field, previous, current }) =>
        `${field.label} changed from ${formatAmendmentValue(field, previous)} to ${formatAmendmentValue(field, current)}`,
    )
    .join("; ") + ".";
}

function changeRow(input: {
  schedule: ScheduleSnapshot;
  item?: SnapshotItem;
  changeType: string;
  oldValue: unknown;
  newValue: unknown;
  affectedItems?: ScheduleChangeAffectedItem[] | null;
  significance?: string;
  notes: string;
  drugId: number;
  brandName?: string | null;
}) {
  return {
    scheduleCode: input.schedule.scheduleCode,
    effectiveDate: input.schedule.effectiveDate,
    changeType: input.changeType,
    liItemId: input.item?.liItemId ?? null,
    pbsCode: input.item?.pbsCode ?? null,
    drugId: input.drugId,
    brandName: input.brandName ?? input.item?.brandName ?? null,
    oldValue: input.oldValue,
    newValue: input.newValue,
    affectedItems: input.affectedItems ?? null,
    significance: input.significance ?? "normal",
    notes: input.notes,
  };
}

export function compareScheduleSnapshots(
  previous: ScheduleSnapshot,
  current: ScheduleSnapshot,
  drugIds: Map<string, number>,
  thresholds: PriceChangeThresholds,
) {
  const changes: ReturnType<typeof changeRow>[] = [];
  const drugKeys = new Set([...previous.drugs.keys(), ...current.drugs.keys()]);

  for (const drugKey of drugKeys) {
    const drugId = drugIds.get(drugKey);
    if (!drugId || !previous.drugs.has(drugKey)) continue;
    const previousItems = previous.drugs.get(drugKey) ?? new Map<string, SnapshotItem>();
    const currentItems = current.drugs.get(drugKey) ?? new Map<string, SnapshotItem>();
    const previousBrands = new Set([...previousItems.values()].map((item) => normalized(item.brandName)));
    const currentBrands = new Map<string, SnapshotItem[]>();

    for (const item of currentItems.values()) {
      const brandKey = normalized(item.brandName);
      currentBrands.set(brandKey, [...(currentBrands.get(brandKey) ?? []), item]);
      if (!previousItems.has(item.liItemId)) {
        changes.push(
          changeRow({
            schedule: current,
            item,
            drugId,
            changeType: "new_item",
            oldValue: null,
            newValue: {
              ...listingSnapshotValue(item),
            },
            notes: "New PBS listing appeared in this schedule.",
          }),
        );
      }
    }

    for (const [brandKey, brandItems] of currentBrands) {
      if (!previousBrands.has(brandKey)) {
        const highSignificance = thresholds.firstNewBrandHighSignificance && previousBrands.size === 1;
        const affectedItems: ScheduleChangeAffectedItem[] = brandItems
          .sort((left, right) => left.liItemId.localeCompare(right.liItemId))
          .map((item) => ({
            liItemId: item.liItemId,
            pbsCode: item.pbsCode,
            brandName: item.brandName,
            strength: item.strength,
            determinedPrice: item.determinedPrice,
            formulary: item.formulary,
          }));
        changes.push(
          changeRow({
            schedule: current,
            drugId,
            changeType: "new_brand",
            oldValue: {
              brands: [...previousBrands],
              baseline_items: [...previousItems.values()].map((item) => ({
                li_item_id: item.liItemId,
                pbs_code: item.pbsCode,
                brand_name: item.brandName,
                strength: item.strength,
                determined_price: item.determinedPrice,
                formulary: item.formulary,
              })),
            },
            newValue: { brand_name: brandItems[0]?.brandName ?? brandKey, affected_items: affectedItems },
            affectedItems,
            brandName: brandItems[0]?.brandName ?? brandKey,
            significance: highSignificance ? "high" : "normal",
            notes: highSignificance
              ? "New brand appeared for a previously single-brand drug; generic entry signal and possible price reduction."
              : previousBrands.size === 1
                ? "New brand appeared for a previously single-brand drug; first-new-brand high-significance policy is disabled."
                : "New brand appeared for this drug.",
          }),
        );
      }
    }

    for (const item of previousItems.values()) {
      const currentItem = currentItems.get(item.liItemId);
      if (!currentItem) {
        changes.push(
          changeRow({
            schedule: current,
            item,
            drugId,
            changeType: "delisted",
            oldValue: {
              li_item_id: item.liItemId,
              pbs_code: item.pbsCode,
              brand_name: item.brandName,
              determined_price: item.determinedPrice,
              formulary: item.formulary,
            },
            newValue: null,
            notes: "PBS listing was present in the previous schedule and is now absent.",
          }),
        );
        continue;
      }

      if (
        item.determinedPrice !== null &&
        currentItem.determinedPrice !== null &&
        item.determinedPrice !== currentItem.determinedPrice
      ) {
        const percentage = percentChange(item.determinedPrice, currentItem.determinedPrice);
        changes.push(
          changeRow({
            schedule: current,
            item: currentItem,
            drugId,
            changeType: "price_change",
            oldValue: { determined_price: item.determinedPrice },
            newValue: {
              determined_price: currentItem.determinedPrice,
              percentage_change: percentage,
            },
            significance: priceChangeSignificance(percentage, thresholds),
            notes: `Determined price changed from ${money(item.determinedPrice)} to ${money(currentItem.determinedPrice)}${percentage === null ? "." : ` (${percentage.toFixed(2)}%).`}`,
          }),
        );
      }

      if (
        item.formulary !== null &&
        currentItem.formulary !== null &&
        item.formulary !== currentItem.formulary
      ) {
        const highSignificance = item.formulary === "F1" && currentItem.formulary === "F2";
        changes.push(
          changeRow({
            schedule: current,
            item: currentItem,
            drugId,
            changeType: "formulary_change",
            oldValue: { formulary: item.formulary },
            newValue: { formulary: currentItem.formulary },
            significance: highSignificance ? "high" : "normal",
            notes: `Formulary changed from ${item.formulary} to ${currentItem.formulary}.`,
          }),
        );
      }

      const listingAmendments = changedListingFields(item, currentItem);
      if (listingAmendments.length > 0) {
        const changedFields = listingAmendments.map(({ field }) => field.key);
        changes.push(
          changeRow({
            schedule: current,
            item: currentItem,
            drugId,
            changeType: "listing_amendment",
            oldValue: {
              ...amendmentValueMap(item, changedFields),
              changed_fields: changedFields,
            },
            newValue: {
              ...amendmentValueMap(currentItem, changedFields),
              changed_fields: changedFields,
            },
            notes: amendmentNotes(listingAmendments),
          }),
        );
      }

      const previousHasPremium = hasPremium(item);
      const currentHasPremium = hasPremium(currentItem);
      if (!previousHasPremium && currentHasPremium) {
        changes.push(
          changeRow({
            schedule: current,
            item: currentItem,
            drugId,
            changeType: "premium_added",
            oldValue: premiumSnapshotValue(item),
            newValue: premiumSnapshotValue(currentItem),
            significance: "high",
            notes: "A PBS patient premium was added for this item.",
          }),
        );
      } else if (previousHasPremium && !currentHasPremium) {
        changes.push(
          changeRow({
            schedule: current,
            item: currentItem,
            drugId,
            changeType: "premium_removed",
            oldValue: premiumSnapshotValue(item),
            newValue: premiumSnapshotValue(currentItem),
            significance: "high",
            notes: "A PBS patient premium was removed for this item.",
          }),
        );
      } else if (
        previousHasPremium &&
        currentHasPremium &&
        premiumFingerprint(item) !== premiumFingerprint(currentItem)
      ) {
        changes.push(
          changeRow({
            schedule: current,
            item: currentItem,
            drugId,
            changeType: "premium_changed",
            oldValue: premiumSnapshotValue(item),
            newValue: premiumSnapshotValue(currentItem),
            significance: "high",
            notes: "A PBS patient premium changed for this item.",
          }),
        );
      }
    }
  }

  return changes;
}

export async function syncScheduleChangesFromStagedData(): Promise<number> {
  const [drugs, snapshots, thresholds] = await Promise.all([
    db.select({ id: drugsTable.id, activeIngredient: drugsTable.activeIngredient }).from(drugsTable),
    loadStagedSnapshots(),
    getPriceChangeThresholds(),
  ]);
  if (snapshots.length < 2) return 0;

  const drugIds = new Map(drugs.map((drug) => [normalized(drug.activeIngredient), drug.id]));
  const changes = snapshots.flatMap((snapshot, index) =>
    index === 0 ? [] : compareScheduleSnapshots(snapshots[index - 1], snapshot, drugIds, thresholds),
  );
  if (changes.length === 0) return 0;

  const legacyNewBrandRows = await db
    .select()
    .from(scheduleChangesTable)
    .where(eq(scheduleChangesTable.changeType, "new_brand"));
  const regularChanges = changes.filter((change) => change.changeType !== "new_brand");
  let insertedCount = 0;

  if (regularChanges.length > 0) {
    const inserted = await db
      .insert(scheduleChangesTable)
      .values(regularChanges)
      .onConflictDoNothing()
      .returning({ id: scheduleChangesTable.id });
    insertedCount += inserted.length;
  }

  const affectedDrugIds = new Set<number>();
  for (const change of changes.filter((candidate) => candidate.changeType === "new_brand")) {
    const existing = legacyNewBrandRows
      .filter(
        (row) =>
          row.scheduleCode === change.scheduleCode &&
          row.effectiveDate === change.effectiveDate &&
          row.drugId === change.drugId &&
          normalized(legacyBrandName(row)) === normalized(change.brandName ?? ""),
      )
      .sort((left, right) => left.id - right.id);
    if (existing[0]) {
      await db
        .update(scheduleChangesTable)
        .set(change)
        .where(eq(scheduleChangesTable.id, existing[0].id));
      if (existing.length > 1) {
        await db
          .delete(scheduleChangesTable)
          .where(inArray(scheduleChangesTable.id, existing.slice(1).map((row) => row.id)));
      }
    } else {
      const [inserted] = await db.insert(scheduleChangesTable).values(change).returning({ id: scheduleChangesTable.id });
      if (inserted) insertedCount += 1;
    }
    affectedDrugIds.add(change.drugId);
  }

  await Promise.all([...affectedDrugIds].map((drugId) => recalculatePredictedReductionsForDrug(drugId)));
  return insertedCount;
}

function legacyBrandName(row: {
  brandName: string | null;
  newValue: unknown;
}): string {
  if (row.brandName) return row.brandName;
  const newValue = isRecord(row.newValue) ? row.newValue : {};
  return typeof newValue.brand_name === "string" ? newValue.brand_name : "";
}