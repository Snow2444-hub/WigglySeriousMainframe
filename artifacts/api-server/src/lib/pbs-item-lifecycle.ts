import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import {
  db,
  ingestionRunsTable,
  pbsItemsTable,
  PRODUCTION_AUTHORITY_SCOPE,
  productionAuthorityRun,
  rawScheduleStagingTable,
  scheduleChangesTable,
  runtimeAuthorityScope,
  type PbsItem,
} from "@workspace/db";

export const ACTIVE_PBS_ITEM_STATUS = "active" as const;
export const DELISTED_PBS_ITEM_STATUS = "delisted" as const;

export function activePbsItemScope() {
  return eq(pbsItemsTable.catalogueStatus, ACTIVE_PBS_ITEM_STATUS);
}

export function isCanonicalCurrentSnapshot(input: {
  scheduleCode: number | undefined;
  effectiveDate: string | undefined;
  snapshotItemCodes: ReadonlySet<string>;
}): boolean {
  return (
    input.scheduleCode !== undefined
    && Number.isInteger(input.scheduleCode)
    && input.scheduleCode > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate ?? "")
    && input.snapshotItemCodes.size > 0
  );
}

export type CatalogueStatusReconciliation = {
  delistedItemCodes: string[];
  reactivatedItemCodes: string[];
  affectedDrugIds: number[];
};

export async function reconcilePbsItemCatalogueStatus(input: {
  authorityScope?: string;
  scheduleCode: number;
  effectiveDate: string;
  snapshotItemCodes: ReadonlySet<string>;
}): Promise<CatalogueStatusReconciliation> {
  if (!isCanonicalCurrentSnapshot(input)) {
    throw new Error("PBS catalogue status requires a complete canonical current snapshot.");
  }

  const authorityScope = input.authorityScope ?? runtimeAuthorityScope();
  const snapshotItemCodes = [...input.snapshotItemCodes];
  const existing = await db
    .select({
      itemCode: pbsItemsTable.itemCode,
      drugId: pbsItemsTable.drugId,
      catalogueStatus: pbsItemsTable.catalogueStatus,
      delistedAt: pbsItemsTable.delistedAt,
      delistedScheduleCode: pbsItemsTable.delistedScheduleCode,
    })
    .from(pbsItemsTable)
    .where(eq(pbsItemsTable.authorityScope, authorityScope));

  const delisted = existing.filter(
    (item) => item.catalogueStatus === ACTIVE_PBS_ITEM_STATUS && !input.snapshotItemCodes.has(item.itemCode),
  );
  const reactivated = existing.filter(
    (item) => item.catalogueStatus === DELISTED_PBS_ITEM_STATUS && input.snapshotItemCodes.has(item.itemCode),
  );

  if (delisted.length > 0) {
    await db
      .update(pbsItemsTable)
      .set({
        catalogueStatus: DELISTED_PBS_ITEM_STATUS,
        delistedAt: input.effectiveDate,
        delistedScheduleCode: input.scheduleCode,
      })
      .where(and(
        eq(pbsItemsTable.authorityScope, authorityScope),
        eq(pbsItemsTable.catalogueStatus, ACTIVE_PBS_ITEM_STATUS),
        notInArray(pbsItemsTable.itemCode, snapshotItemCodes),
      ));
  }
  if (reactivated.length > 0) {
    await db
      .update(pbsItemsTable)
      .set({
        catalogueStatus: ACTIVE_PBS_ITEM_STATUS,
        delistedAt: null,
        delistedScheduleCode: null,
      })
      .where(and(
        eq(pbsItemsTable.authorityScope, authorityScope),
        eq(pbsItemsTable.catalogueStatus, DELISTED_PBS_ITEM_STATUS),
        inArray(pbsItemsTable.itemCode, reactivated.map((item) => item.itemCode)),
      ));
  }

  return {
    delistedItemCodes: delisted.map((item) => item.itemCode).sort(),
    reactivatedItemCodes: reactivated.map((item) => item.itemCode).sort(),
    affectedDrugIds: [...new Set([...delisted, ...reactivated].map((item) => item.drugId))].sort((a, b) => a - b),
  };
}

export type PbsItemWithCatalogueStatus = Pick<PbsItem, "itemCode" | "catalogueStatus">;

type JsonRecord = Record<string, unknown>;

function recordsFromSnapshotPayload(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter((value): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  );
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  for (const key of ["data", "items", "results", "records"]) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is JsonRecord =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
      );
    }
  }
  return [];
}

function snapshotItemCode(record: JsonRecord): string | undefined {
  const value = record.li_item_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type CanonicalCurrentPbsSnapshot = {
  runId: number;
  scheduleCode: number;
  effectiveDate: string;
  snapshotItemCodes: Set<string>;
};

export async function loadLatestCanonicalCurrentPbsSnapshot(): Promise<CanonicalCurrentPbsSnapshot> {
  const [run] = await db
    .select({
      id: ingestionRunsTable.id,
      scheduleCode: ingestionRunsTable.scheduleCode,
      scheduleEffectiveDate: ingestionRunsTable.scheduleEffectiveDate,
    })
    .from(ingestionRunsTable)
    .where(and(
      eq(ingestionRunsTable.authorityScope, PRODUCTION_AUTHORITY_SCOPE),
      eq(ingestionRunsTable.mode, "current"),
      eq(ingestionRunsTable.status, "completed"),
      eq(ingestionRunsTable.snapshotComplete, true),
      isNotNull(ingestionRunsTable.scheduleCode),
      isNotNull(ingestionRunsTable.scheduleEffectiveDate),
    ))
    .orderBy(desc(ingestionRunsTable.scheduleEffectiveDate), desc(ingestionRunsTable.id))
    .limit(1);
  if (!run || run.scheduleCode === null || run.scheduleEffectiveDate === null) {
    throw new Error("No complete production current PBS ingestion run is available for repair.");
  }

  const pages = await db
    .select({
      pageNumber: rawScheduleStagingTable.pageNumber,
      coverageScope: rawScheduleStagingTable.coverageScope,
      coverageComplete: rawScheduleStagingTable.coverageComplete,
      payload: rawScheduleStagingTable.payload,
    })
    .from(rawScheduleStagingTable)
    .where(and(
      eq(rawScheduleStagingTable.endpoint, "items"),
      eq(rawScheduleStagingTable.requestKey, `items-snapshot:schedule-${run.scheduleCode}:run-${run.id}`),
    ))
    .orderBy(asc(rawScheduleStagingTable.pageNumber));
  if (pages.length === 0 || pages.some((page) => page.coverageScope !== "schedule" || !page.coverageComplete)) {
    throw new Error(`Complete current PBS run ${run.id} has no valid schedule-wide items snapshot.`);
  }

  const snapshotItemCodes = new Set<string>();
  for (const page of pages) {
    for (const record of recordsFromSnapshotPayload(page.payload)) {
      const itemCode = snapshotItemCode(record);
      if (itemCode) snapshotItemCodes.add(itemCode);
    }
  }
  if (!isCanonicalCurrentSnapshot({
    scheduleCode: run.scheduleCode,
    effectiveDate: run.scheduleEffectiveDate,
    snapshotItemCodes,
  })) {
    throw new Error(`Production run ${run.id} is not a canonical current PBS snapshot.`);
  }
  return {
    runId: run.id,
    scheduleCode: run.scheduleCode,
    effectiveDate: run.scheduleEffectiveDate,
    snapshotItemCodes,
  };
}

export type PbsCatalogueRepairReportRow = {
  itemCode: string;
  pbsCode: string | null;
  brandName: string;
  drugId: number;
  currentStatus: "active" | "delisted";
  proposedStatus: "active" | "delisted";
};

export type PbsCatalogueRepairReport = {
  generatedAt: string;
  sourceRunId: number;
  scheduleCode: number;
  effectiveDate: string;
  snapshotItemCount: number;
  proposedChangeCount: number;
  rows: PbsCatalogueRepairReportRow[];
};

export type PbsDelistingDateBackfillRow = {
  itemCode: string;
  liItemId: string | null;
  pbsCode: string | null;
  brandName: string;
  currentDelistedAt: string | null;
  currentDelistedScheduleCode: number | null;
  proposedDelistedAt: string | null;
  proposedDelistedScheduleCode: number | null;
  scheduleChangeId: number | null;
};

export type PbsDelistingDateBackfillReport = {
  generatedAt: string;
  delistedItemCount: number;
  matchedItemCount: number;
  unmatchedItemCount: number;
  rows: PbsDelistingDateBackfillRow[];
};

export async function buildPbsDelistingDateBackfillReport(): Promise<PbsDelistingDateBackfillReport> {
  const [items, changes] = await Promise.all([
    db
      .select({
        itemCode: pbsItemsTable.itemCode,
        liItemId: pbsItemsTable.liItemId,
        pbsCode: pbsItemsTable.pbsCode,
        brandName: pbsItemsTable.brandName,
        delistedAt: pbsItemsTable.delistedAt,
        delistedScheduleCode: pbsItemsTable.delistedScheduleCode,
      })
      .from(pbsItemsTable)
      .where(and(
        eq(pbsItemsTable.authorityScope, PRODUCTION_AUTHORITY_SCOPE),
        eq(pbsItemsTable.catalogueStatus, DELISTED_PBS_ITEM_STATUS),
      ))
      .orderBy(asc(pbsItemsTable.itemCode)),
    db
      .select({
        id: scheduleChangesTable.id,
        liItemId: scheduleChangesTable.liItemId,
        pbsCode: scheduleChangesTable.pbsCode,
        effectiveDate: scheduleChangesTable.effectiveDate,
        scheduleCode: scheduleChangesTable.scheduleCode,
      })
      .from(scheduleChangesTable)
      .where(and(
        eq(scheduleChangesTable.changeType, "delisted"),
        productionAuthorityRun(scheduleChangesTable.authorityRunId),
      ))
      .orderBy(desc(scheduleChangesTable.effectiveDate), desc(scheduleChangesTable.id)),
  ]);

  const rows = items.map((item) => {
    const exactIdentifiers = new Set([item.itemCode, item.liItemId].filter((value): value is string => Boolean(value)));
    const exactMatches = changes.filter((change) => change.liItemId !== null && exactIdentifiers.has(change.liItemId));
    const pbsMatches = changes.filter((change) =>
      exactMatches.length === 0
      && item.pbsCode !== null
      && change.pbsCode === item.pbsCode,
    );
    const event = [...exactMatches, ...pbsMatches]
      .sort((left, right) => right.effectiveDate.localeCompare(left.effectiveDate) || right.id - left.id)[0];
    return {
      itemCode: item.itemCode,
      liItemId: item.liItemId,
      pbsCode: item.pbsCode,
      brandName: item.brandName,
      currentDelistedAt: item.delistedAt,
      currentDelistedScheduleCode: item.delistedScheduleCode,
      proposedDelistedAt: event?.effectiveDate ?? null,
      proposedDelistedScheduleCode: event?.scheduleCode ?? null,
      scheduleChangeId: event?.id ?? null,
    };
  });
  const matchedItemCount = rows.filter((row) => row.proposedDelistedAt !== null && row.proposedDelistedScheduleCode !== null).length;
  return {
    generatedAt: new Date().toISOString(),
    delistedItemCount: rows.length,
    matchedItemCount,
    unmatchedItemCount: rows.length - matchedItemCount,
    rows,
  };
}

export async function applyPbsDelistingDateBackfill(
  report: PbsDelistingDateBackfillReport,
): Promise<number> {
  if (report.unmatchedItemCount > 0 || report.rows.some((row) =>
    row.proposedDelistedAt === null || row.proposedDelistedScheduleCode === null
  )) {
    throw new Error("Cannot apply PBS delisting date backfill while any delisted item lacks a matching schedule-change event.");
  }
  let updatedCount = 0;
  await db.transaction(async (tx) => {
    for (const row of report.rows) {
      const [updated] = await tx
        .update(pbsItemsTable)
        .set({
          delistedAt: row.proposedDelistedAt,
          delistedScheduleCode: row.proposedDelistedScheduleCode,
        })
        .where(and(
          eq(pbsItemsTable.itemCode, row.itemCode),
          eq(pbsItemsTable.authorityScope, PRODUCTION_AUTHORITY_SCOPE),
          eq(pbsItemsTable.catalogueStatus, DELISTED_PBS_ITEM_STATUS),
        ))
        .returning({ itemCode: pbsItemsTable.itemCode });
      if (updated) updatedCount += 1;
    }
  });
  return updatedCount;
}

export async function buildPbsCatalogueRepairReport(
  snapshot: CanonicalCurrentPbsSnapshot,
): Promise<PbsCatalogueRepairReport> {
  const items = await db
    .select({
      itemCode: pbsItemsTable.itemCode,
      pbsCode: pbsItemsTable.pbsCode,
      brandName: pbsItemsTable.brandName,
      drugId: pbsItemsTable.drugId,
      catalogueStatus: pbsItemsTable.catalogueStatus,
    })
    .from(pbsItemsTable)
    .where(eq(pbsItemsTable.authorityScope, PRODUCTION_AUTHORITY_SCOPE))
    .orderBy(asc(pbsItemsTable.itemCode));
  const rows = items
    .map((item) => ({
      itemCode: item.itemCode,
      pbsCode: item.pbsCode,
      brandName: item.brandName,
      drugId: item.drugId,
      currentStatus: item.catalogueStatus,
      proposedStatus: snapshot.snapshotItemCodes.has(item.itemCode) ? "active" as const : "delisted" as const,
    }))
    .filter((row) => row.currentStatus !== row.proposedStatus);
  return {
    generatedAt: new Date().toISOString(),
    sourceRunId: snapshot.runId,
    scheduleCode: snapshot.scheduleCode,
    effectiveDate: snapshot.effectiveDate,
    snapshotItemCount: snapshot.snapshotItemCodes.size,
    proposedChangeCount: rows.length,
    rows,
  };
}