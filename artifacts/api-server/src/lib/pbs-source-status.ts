import { asc, desc, eq } from "drizzle-orm";
import {
  db,
  pbsPublishedFilesTable,
  pbsSourceRegistryTable,
  type PbsPublishedFile,
} from "@workspace/db";

export type PublishedSourceKey =
  | "anniversary_indicative"
  | "section_99acp"
  | "first_new_brand"
  | "subject_to_price_disclosure"
  | "indicative_non_efc"
  | "indicative_efc"
  | "confirmed_non_efc"
  | "confirmed_efc"
  | "combination_flow_on";

type SourceCadence = "annual_august" | "price_disclosure_cycle" | "unconfigured";

export const PBS_SOURCE_DEFINITIONS = [
  {
    sourceKey: "anniversary_indicative",
    label: "Anniversary indicative list",
    sourceFamily: "Anniversary reductions",
    pageUrl: "https://www.pbs.gov.au/industry/pricing/anniversary-price-reductions",
    cadenceType: "annual_august",
    cadenceMonth: 8,
    cadenceDay: 1,
    cadenceConfig: { expectedMonth: 8, expectedDay: 1 },
    staleAfterDays: 14,
  },
  {
    sourceKey: "section_99acp",
    label: "Section 99ACP list",
    sourceFamily: "Anniversary reductions",
    pageUrl: "https://www.pbs.gov.au/industry/pricing/anniversary-price-reductions",
    cadenceType: "annual_august",
    cadenceMonth: 8,
    cadenceDay: 1,
    cadenceConfig: { expectedMonth: 8, expectedDay: 1 },
    staleAfterDays: 14,
  },
  {
    sourceKey: "first_new_brand",
    label: "First New Brand workbook",
    sourceFamily: "Brand reductions",
    pageUrl: "https://www.pbs.gov.au/industry/pricing/pbs-items/first-new-brand-price-reductions",
    cadenceType: "unconfigured",
    cadenceMonth: null,
    cadenceDay: null,
    cadenceConfig: { reason: "PBS cadence not confirmed" },
    staleAfterDays: 14,
  },
  {
    sourceKey: "subject_to_price_disclosure",
    label: "Drugs subject to price disclosure",
    sourceFamily: "Price disclosure",
    pageUrl: "https://www.pbs.gov.au/industry/pricing/price-disclosure-spd/drugs-subject-to-price-disclosure",
    cadenceType: "price_disclosure_cycle",
    cadenceMonth: null,
    cadenceDay: null,
    cadenceConfig: { cycleMonths: [4, 10] },
    staleAfterDays: 14,
  },
  {
    sourceKey: "indicative_non_efc",
    label: "Indicative prices · excluding EFC",
    sourceFamily: "Price disclosure",
    pageUrl: "https://www.pbs.gov.au/industry/pricing/price-disclosure-spd/current-price-disclosure-cycle",
    cadenceType: "price_disclosure_cycle",
    cadenceMonth: null,
    cadenceDay: null,
    cadenceConfig: { cycleMonths: [4, 10] },
    staleAfterDays: 14,
  },
  {
    sourceKey: "indicative_efc",
    label: "Indicative prices · EFC drugs",
    sourceFamily: "Price disclosure",
    pageUrl: "https://www.pbs.gov.au/industry/pricing/price-disclosure-spd/current-price-disclosure-cycle",
    cadenceType: "price_disclosure_cycle",
    cadenceMonth: null,
    cadenceDay: null,
    cadenceConfig: { cycleMonths: [4, 10] },
    staleAfterDays: 14,
  },
  {
    sourceKey: "confirmed_non_efc",
    label: "Confirmed prices · excluding EFC",
    sourceFamily: "Price disclosure",
    pageUrl: "https://www.pbs.gov.au/industry/pricing/price-disclosure-spd/current-price-disclosure-cycle",
    cadenceType: "price_disclosure_cycle",
    cadenceMonth: null,
    cadenceDay: null,
    cadenceConfig: { cycleMonths: [4, 10] },
    staleAfterDays: 14,
  },
  {
    sourceKey: "confirmed_efc",
    label: "Confirmed prices · EFC drugs",
    sourceFamily: "Price disclosure",
    pageUrl: "https://www.pbs.gov.au/industry/pricing/price-disclosure-spd/current-price-disclosure-cycle",
    cadenceType: "price_disclosure_cycle",
    cadenceMonth: null,
    cadenceDay: null,
    cadenceConfig: { cycleMonths: [4, 10] },
    staleAfterDays: 14,
  },
  {
    sourceKey: "combination_flow_on",
    label: "Combination flow-on files",
    sourceFamily: "Combination reductions",
    pageUrl: "https://www.pbs.gov.au/industry/pricing",
    cadenceType: "annual_august",
    cadenceMonth: 8,
    cadenceDay: 1,
    cadenceConfig: { expectedMonth: 8, expectedDay: 1 },
    staleAfterDays: 14,
  },
] as const satisfies ReadonlyArray<{
  sourceKey: PublishedSourceKey;
  label: string;
  sourceFamily: string;
  pageUrl: string;
  cadenceType: SourceCadence;
  cadenceMonth: number | null;
  cadenceDay: number | null;
  cadenceConfig: Record<string, unknown>;
  staleAfterDays: number;
}>;

export type PbsSourceStatus = {
  sourceKey: PublishedSourceKey;
  label: string;
  sourceFamily: string;
  pageUrl: string;
  cadenceType: SourceCadence;
  cadenceLabel: string;
  status: "OK" | "NO_RELEVANT_ROWS" | "COVERAGE_GAP" | "STALE" | "FAILED";
  lastSuccessfulPullAt: Date | null;
  lastSuccessfulParseAt: Date | null;
  publicationDate: string | null;
  nextExpectedRefreshDate: string | null;
  staleAfterDate: string | null;
  latestAttemptAt: Date | null;
  latestAttemptStatus: string | null;
  latestFailureStage: string | null;
  latestFailureMessage: string | null;
  latestFileName: string | null;
  latestFileUrl: string | null;
  latestFileSha256: string | null;
  lastSuccessfulFileName: string | null;
  lastSuccessfulFileSha256: string | null;
  parserVersion: string | null;
  totalRows: number;
  matchedRows: number;
  rejectedRows: number;
  watchlistUnmatchedRows: number;
};

function dateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextAnnualAugustDate(anchor: string): string {
  const year = Number(anchor.slice(0, 4));
  const candidate = `${year}-08-01`;
  return candidate > anchor ? candidate : `${year + 1}-08-01`;
}

function nextCycleDate(anchor: string): string {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  if (month < 4 || (month === 4 && anchor < `${year}-04-01`)) return `${year}-04-01`;
  if (month < 10 || (month === 10 && anchor < `${year}-10-01`)) return `${year}-10-01`;
  return `${year + 1}-04-01`;
}

function nextExpectedRefresh(
  definition: (typeof PBS_SOURCE_DEFINITIONS)[number],
  anchor: string | null,
  today: string,
): string | null {
  if (definition.cadenceType === "unconfigured") return null;
  return definition.cadenceType === "annual_august"
    ? nextAnnualAugustDate(anchor ?? today)
    : nextCycleDate(anchor ?? today);
}

function isLegacyNoRelevantRowsObservation(file: PbsPublishedFile): boolean {
  return (
    file.status === "completed" &&
    file.parseHealth === "rejected" &&
    file.fetchStatus === "succeeded" &&
    file.parseStatus === "failed" &&
    file.failureStage === "parse" &&
    file.totalRows > 0 &&
    file.matchedRows === 0 &&
    file.watchlistUnmatchedRows === 0 &&
    !file.errorMessage
  );
}

function isSuccessfulObservation(file: PbsPublishedFile): boolean {
  return (
    isLegacyNoRelevantRowsObservation(file) ||
    (
      file.status === "completed" &&
      file.parseHealth === "healthy" &&
      file.fetchStatus !== "failed" &&
      file.parseStatus !== "failed"
    )
  );
}

function failureStage(file: PbsPublishedFile): string | null {
  if (file.failureStage) return file.failureStage;
  if (file.status === "failed" && file.rawContentBase64) return "parse";
  if (file.status === "failed") return "fetch";
  if (file.parseHealth !== "healthy") return "parse";
  return null;
}

function cadenceLabel(definition: (typeof PBS_SOURCE_DEFINITIONS)[number]): string {
  if (definition.cadenceType === "annual_august") return "Annual · expected 1 Aug";
  if (definition.cadenceType === "price_disclosure_cycle") return "Price-disclosure cycle";
  return "Cadence not configured";
}

function definitionFor(sourceKey: string) {
  return PBS_SOURCE_DEFINITIONS.find((definition) => definition.sourceKey === sourceKey);
}

export async function ensurePbsSourceRegistry(): Promise<void> {
  await db
    .insert(pbsSourceRegistryTable)
    .values(
      PBS_SOURCE_DEFINITIONS.map((definition) => ({
        sourceKey: definition.sourceKey,
        label: definition.label,
        sourceFamily: definition.sourceFamily,
        pageUrl: definition.pageUrl,
        cadenceType: definition.cadenceType,
        cadenceMonth: definition.cadenceMonth,
        cadenceDay: definition.cadenceDay,
        cadenceConfig: definition.cadenceConfig,
        staleAfterDays: definition.staleAfterDays,
      })),
    )
    .onConflictDoNothing({ target: pbsSourceRegistryTable.sourceKey });
}

function observationPublicationDate(file: PbsPublishedFile): string | null {
  return file.reportPublicationDate ?? file.effectiveDate;
}

export function evaluatePbsSourceStatus(
  definition: (typeof PBS_SOURCE_DEFINITIONS)[number],
  observations: PbsPublishedFile[],
  today: string,
): PbsSourceStatus {
  return sourceStatus(definition, definition.staleAfterDays, observations, today);
}

function sourceStatus(
  definition: (typeof PBS_SOURCE_DEFINITIONS)[number],
  staleAfterDays: number,
  observations: PbsPublishedFile[],
  today: string,
): PbsSourceStatus {
  const ordered = [...observations].sort((left, right) => right.id - left.id);
  const latest = ordered[0] ?? null;
  const successful = ordered.find(isSuccessfulObservation) ?? null;
  const publicationDate = successful ? observationPublicationDate(successful) : null;
  const anchor = publicationDate ?? dateOnly(successful?.retrievedAt) ?? today;
  const nextExpected = nextExpectedRefresh(definition, anchor, today);
  const staleAfter = nextExpected ? addDays(nextExpected, staleAfterDays) : null;
  const latestSucceeded = latest ? isSuccessfulObservation(latest) : false;
  const status: PbsSourceStatus["status"] =
    !latestSucceeded || !successful
      ? "FAILED"
      : latest && latest.watchlistUnmatchedRows > 0
        ? "COVERAGE_GAP"
        : staleAfter && today > staleAfter
        ? "STALE"
        : latest && latest.totalRows > 0 && latest.matchedRows === 0
          ? "NO_RELEVANT_ROWS"
          : "OK";
  const latestFailure = latest && !latestSucceeded ? latest : null;

  return {
    sourceKey: definition.sourceKey,
    label: definition.label,
    sourceFamily: definition.sourceFamily,
    pageUrl: definition.pageUrl,
    cadenceType: definition.cadenceType,
    cadenceLabel: cadenceLabel(definition),
    status,
    lastSuccessfulPullAt: successful?.retrievedAt ?? null,
    lastSuccessfulParseAt: successful?.parsedAt ?? successful?.retrievedAt ?? null,
    publicationDate,
    nextExpectedRefreshDate: nextExpected,
    staleAfterDate: staleAfter,
    latestAttemptAt: latest?.retrievedAt ?? null,
    latestAttemptStatus: latest?.status ?? null,
    latestFailureStage: latestFailure ? failureStage(latest) : successful ? null : "not_ingested",
    latestFailureMessage: latestFailure?.errorMessage ?? (successful ? null : "No successful observation has been recorded yet"),
    latestFileName: latest?.fileName ?? null,
    latestFileUrl: latest?.fileUrl ?? null,
    latestFileSha256: latest?.fileSha256 ?? null,
    lastSuccessfulFileName: successful?.fileName ?? null,
    lastSuccessfulFileSha256: successful?.fileSha256 ?? null,
    parserVersion: latest?.parserVersion ?? successful?.parserVersion ?? null,
    totalRows: latest?.totalRows ?? 0,
    matchedRows: latest?.matchedRows ?? 0,
    rejectedRows: latest?.rejectedRows ?? 0,
    watchlistUnmatchedRows: latest?.watchlistUnmatchedRows ?? 0,
  };
}

export async function refreshPbsSourceRegistryStatus(asOf = new Date()): Promise<PbsSourceStatus[]> {
  await ensurePbsSourceRegistry();
  const [definitions, observations] = await Promise.all([
    db.select().from(pbsSourceRegistryTable).orderBy(asc(pbsSourceRegistryTable.sourceFamily), asc(pbsSourceRegistryTable.label)),
    db.select().from(pbsPublishedFilesTable).orderBy(desc(pbsPublishedFilesTable.id)),
  ]);
  const today = dateOnly(asOf) ?? new Date().toISOString().slice(0, 10);
  const resultRows = definitions.flatMap((registry) => {
    const definition = definitionFor(registry.sourceKey);
    if (!definition) return [];
    const sourceObservations = observations.filter((file) => file.sourceKey === registry.sourceKey);
    const result = sourceStatus(
      definition,
      registry.staleAfterDays,
      sourceObservations,
      today,
    );
    const ordered = [...sourceObservations].sort((left, right) => right.id - left.id);
    return [{
      result,
      latestAttemptId: ordered[0]?.id ?? null,
      lastSuccessfulFileId: ordered.find(isSuccessfulObservation)?.id ?? null,
    }];
  });

  await Promise.all(
    resultRows.map(({ result, latestAttemptId, lastSuccessfulFileId }) =>
      db
        .update(pbsSourceRegistryTable)
        .set({
          latestAttemptFileId: latestAttemptId,
          latestAttemptAt: result.latestAttemptAt,
          lastSuccessfulFileId,
          lastSuccessfulFetchAt: result.lastSuccessfulPullAt,
          lastSuccessfulParseAt: result.lastSuccessfulParseAt,
          lastSuccessfulPublicationDate: result.publicationDate,
          nextExpectedRefreshDate: result.nextExpectedRefreshDate,
          staleAfterDate: result.staleAfterDate,
          status: result.status,
          lastFailureStage: result.latestFailureStage,
          lastFailureAt: result.latestFailureStage ? result.latestAttemptAt : null,
          lastFailureMessage: result.latestFailureMessage,
          updatedAt: new Date(),
        })
        .where(eq(pbsSourceRegistryTable.sourceKey, result.sourceKey)),
    ),
  );
  return resultRows.map(({ result }) => result);
}

export async function listPbsSourceStatuses(): Promise<PbsSourceStatus[]> {
  return refreshPbsSourceRegistryStatus();
}