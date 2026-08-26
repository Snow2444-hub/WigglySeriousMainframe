import { db, drugsTable, rawScheduleStagingTable, scheduleChangesTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";

type JsonRecord = Record<string, unknown>;

type SnapshotItem = {
  liItemId: string;
  pbsCode: string | null;
  drugKey: string;
  brandName: string;
  determinedPrice: number | null;
  formulary: "F1" | "F2" | null;
};

type ScheduleSnapshot = {
  scheduleCode: number;
  effectiveDate: string;
  drugs: Map<string, Map<string, SnapshotItem>>;
};

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
  const pages = await db
    .select({
      id: rawScheduleStagingTable.id,
      endpoint: rawScheduleStagingTable.endpoint,
      requestKey: rawScheduleStagingTable.requestKey,
      payload: rawScheduleStagingTable.payload,
    })
    .from(rawScheduleStagingTable)
    .where(eq(rawScheduleStagingTable.endpoint, "items"))
    .orderBy(asc(rawScheduleStagingTable.id));

  const schedulePages = await db
    .select({
      endpoint: rawScheduleStagingTable.endpoint,
      payload: rawScheduleStagingTable.payload,
    })
    .from(rawScheduleStagingTable)
    .where(eq(rawScheduleStagingTable.endpoint, "schedules"))
    .orderBy(asc(rawScheduleStagingTable.id));

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
        determinedPrice: numberField(record, "determined_price", "aemp", "current_aemp") ?? null,
        formulary:
          stringField(record, "formulary") === "F1" || stringField(record, "formulary") === "F2"
            ? (stringField(record, "formulary") as "F1" | "F2")
            : null,
      });
      snapshot.drugs.set(drugKey, items);
      snapshots.set(key, snapshot);
    }
  }

  return [...snapshots.values()].sort((left, right) =>
    left.effectiveDate.localeCompare(right.effectiveDate),
  );
}

function changeRow(input: {
  schedule: ScheduleSnapshot;
  item: SnapshotItem;
  changeType: string;
  oldValue: unknown;
  newValue: unknown;
  significance?: string;
  notes: string;
  drugId: number;
}) {
  return {
    scheduleCode: input.schedule.scheduleCode,
    effectiveDate: input.schedule.effectiveDate,
    changeType: input.changeType,
    liItemId: input.item.liItemId,
    pbsCode: input.item.pbsCode,
    drugId: input.drugId,
    brandName: input.item.brandName,
    oldValue: input.oldValue,
    newValue: input.newValue,
    significance: input.significance ?? "normal",
    notes: input.notes,
  };
}

function compareSnapshots(
  previous: ScheduleSnapshot,
  current: ScheduleSnapshot,
  drugIds: Map<string, number>,
) {
  const changes: ReturnType<typeof changeRow>[] = [];
  const drugKeys = new Set([...previous.drugs.keys(), ...current.drugs.keys()]);

  for (const drugKey of drugKeys) {
    const drugId = drugIds.get(drugKey);
    if (!drugId || !previous.drugs.has(drugKey) || !current.drugs.has(drugKey)) continue;
    const previousItems = previous.drugs.get(drugKey) ?? new Map<string, SnapshotItem>();
    const currentItems = current.drugs.get(drugKey) ?? new Map<string, SnapshotItem>();
    const previousBrands = new Set([...previousItems.values()].map((item) => normalized(item.brandName)));
    const currentBrands = new Map<string, SnapshotItem>();

    for (const item of currentItems.values()) {
      currentBrands.set(normalized(item.brandName), item);
      if (!previousItems.has(item.liItemId)) {
        changes.push(
          changeRow({
            schedule: current,
            item,
            drugId,
            changeType: "new_item",
            oldValue: null,
            newValue: {
              li_item_id: item.liItemId,
              pbs_code: item.pbsCode,
              brand_name: item.brandName,
              determined_price: item.determinedPrice,
              formulary: item.formulary,
            },
            notes: "New PBS listing appeared in this schedule.",
          }),
        );
      }
    }

    for (const [brandKey, item] of currentBrands) {
      if (!previousBrands.has(brandKey)) {
        const highSignificance = previousBrands.size === 1;
        changes.push(
          changeRow({
            schedule: current,
            item,
            drugId,
            changeType: "new_brand",
            oldValue: { brands: [...previousBrands] },
            newValue: { brand_name: item.brandName, li_item_id: item.liItemId },
            significance: highSignificance ? "high" : "normal",
            notes: highSignificance
              ? "New brand appeared for a previously single-brand drug; generic entry signal and possible price reduction."
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
    }
  }

  return changes;
}

export async function syncScheduleChangesFromStagedData(): Promise<number> {
  const [drugs, snapshots] = await Promise.all([
    db.select({ id: drugsTable.id, activeIngredient: drugsTable.activeIngredient }).from(drugsTable),
    loadStagedSnapshots(),
  ]);
  if (snapshots.length < 2) return 0;

  const drugIds = new Map(drugs.map((drug) => [normalized(drug.activeIngredient), drug.id]));
  const changes = snapshots.flatMap((snapshot, index) =>
    index === 0 ? [] : compareSnapshots(snapshots[index - 1], snapshot, drugIds),
  );
  if (changes.length === 0) return 0;

  const inserted = await db
    .insert(scheduleChangesTable)
    .values(changes)
    .onConflictDoNothing()
    .returning({ id: scheduleChangesTable.id });
  return inserted.length;
}