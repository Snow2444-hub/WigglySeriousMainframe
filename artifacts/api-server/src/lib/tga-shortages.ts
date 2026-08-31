import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  drugsTable,
  artgEntriesTable,
  ingestionRunsTable,
  pbsItemsTable,
  pbsPublishedFilesTable,
  pbsWatchlistTable,
  tgaShortageMatchesTable,
  tgaShortageObservationsTable,
  productionAuthorityRun,
  runtimeAuthorityScope,
  withDerivedAuthority,
  withGlobalAuthority,
} from "@workspace/db";
import { ingredientContainsWholeWord, normaliseIngredientForMatch, normaliseProductForMatch } from "./ingredient-normalisation";
import { activePbsItemScope } from "./pbs-item-lifecycle";
import { ensurePbsSourceRegistry, listPbsSourceStatuses, type PbsSourceStatus } from "./pbs-source-status";

export const TGA_ACTIVE_SOURCE_KEY = "tga_shortages_active" as const;
export const TGA_ARCHIVE_SOURCE_KEY = "tga_shortages_archive" as const;
export const TGA_PARSER_VERSION = "tga-shortages-v1";
export const TGA_MATCHER_VERSION = "tga-shortages-matcher-v1";
export const TGA_ACTIVE_URL = "https://apps.tga.gov.au/Prod/msi/search?shortagetype=All&exportType=Excel";
export const TGA_ARCHIVE_URL = "https://apps.tga.gov.au/Prod/msi/search?shortagetype=All&exportType=CSVExportArchive";
export const TGA_SHORTAGES_TOKEN_ENV = "TGA_SHORTAGES_INGESTION_TOKEN";
const TGA_LOCK_KEY = 502_668_452;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const USER_AGENT = "dispense-pbs-manager/1.0 (TGA medicine shortages)";

export type TgaSourceKind = "active" | "archive";
export type TgaIngestionScope = TgaSourceKind | "both";
export type TgaShortageSection = "current" | "anticipated" | "discontinued" | "resolved";
export type TgaMatchConfidence = "exact" | "high" | "review";

export type TgaCsvRecord = {
  recordNumber: number;
  values: string[];
};

export type TgaParsedRow = {
  sourceRowNumber: number;
  rawRow: Record<string, string | null>;
  artgId: string;
  artgName: string;
  activeIngredients: string;
  dosageForm: string;
  quantityOfActiveIngredients: string | null;
  sponsor: string;
  phone: string | null;
  shortageStatus: string | null;
  supplyImpactStartDate: string | null;
  supplyImpactEndDate: string | null;
  deletionFromMarket: string | null;
  shortageImpactRating: string | null;
  availability: string | null;
  reason: string | null;
  managementAction: string | null;
  lastUpdated: string | null;
  episodeKey: string;
  canonicalHash: string;
};

export type TgaParseResult = {
  headerRecordNumber: number;
  headers: string[];
  rows: TgaParsedRow[];
  rejectedRows: number;
  warnings: string[];
  reportPublicationDate: string | null;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim();
}

function headerKey(value: string): string {
  return clean(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseCsvRecords(input: string): TgaCsvRecord[] {
  const text = input.replace(/^\uFEFF/, "");
  const records: TgaCsvRecord[] = [];
  let values: string[] = [];
  let value = "";
  let quoted = false;
  let recordNumber = 1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      values.push(value);
      value = "";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      values.push(value);
      value = "";
      if (values.some((entry) => clean(entry) !== "")) records.push({ recordNumber, values });
      recordNumber += 1;
      values = [];
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("TGA export contains an unterminated quoted field");
  if (value !== "" || values.length > 0) {
    values.push(value);
    if (values.some((entry) => clean(entry) !== "")) records.push({ recordNumber, values });
  }
  return records;
}

function parseAustralianDate(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}

function parseReportDate(text: string): string | null {
  const named = text.match(/\bReport generated\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (named) {
    const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
      .indexOf(named[2].toLocaleLowerCase()) + 1;
    return `${named[3]}-${String(month).padStart(2, "0")}-${String(Number(named[1])).padStart(2, "0")}`;
  }
  const numeric = text.match(/\bReport generated\s+(\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/i);
  return numeric ? parseAustralianDate(numeric[1]) : null;
}

function headerIndex(headers: string[], names: string[]): number | undefined {
  const normalized = headers.map(headerKey);
  return names.map(headerKey).map((name) => normalized.indexOf(name)).find((index) => index >= 0);
}

function requiredIndexes(headers: string[], kind: TgaSourceKind): Record<string, number> {
  const aliases: Record<string, string[]> = {
    artgId: ["artg id"],
    artgName: ["artg name"],
    activeIngredients: ["active ingredients"],
    dosageForm: ["dosage form"],
    sponsor: ["sponsor"],
    supplyImpactStartDate: ["supply impact start date"],
    supplyImpactEndDate: ["supply impact end date"],
    deletionFromMarket: ["deletion from market"],
    shortageImpactRating: ["shortage impact rating"],
    ...(kind === "active"
      ? { shortageStatus: ["shortage status"], availability: ["availability"], reason: ["reason"], managementAction: ["management action"], lastUpdated: ["last updated"] }
      : {}),
  };
  const result: Record<string, number> = {};
  for (const [name, candidates] of Object.entries(aliases)) {
    const index = headerIndex(headers, candidates);
    if (index === undefined) throw new Error(`TGA ${kind} export is missing required column "${candidates[0]}"`);
    result[name] = index;
  }
  return result;
}

function recordValue(values: string[], index: number | undefined): string | null {
  if (index === undefined) return null;
  const value = clean(values[index]);
  return value || null;
}

function shortageStatus(kind: TgaSourceKind, values: Record<string, string | null>): string | null {
  if (kind === "active") return values.shortageStatus;
  if (values.deletionFromMarket) return "Discontinued";
  if (values.supplyImpactEndDate) return "Resolved";
  return null;
}

function sourceRowHash(values: Record<string, string | null>): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function parseTgaCsv(input: Buffer | string, kind: TgaSourceKind): TgaParseResult {
  const text = Buffer.isBuffer(input) ? input.toString("utf8").replace(/^\uFEFF/, "") : input.replace(/^\uFEFF/, "");
  const records = parseCsvRecords(text);
  const headerRecord = records.find((record) => {
    try {
      requiredIndexes(record.values, kind);
      return true;
    } catch {
      return false;
    }
  });
  if (!headerRecord) throw new Error(`TGA ${kind} export did not contain a recognizable header`);
  const indexes = requiredIndexes(headerRecord.values, kind);
  const headers = headerRecord.values.map(clean);
  const rows: TgaParsedRow[] = [];
  const warnings: string[] = [];
  let rejectedRows = 0;
  for (const record of records.filter((candidate) => candidate.recordNumber > headerRecord.recordNumber)) {
    const blank = record.values.every((value) => clean(value) === "");
    if (blank) continue;
    const surplus = record.values.length - headers.length;
    if (surplus > 0) {
      const extras = record.values.slice(headers.length);
      if (extras.some((value) => clean(value) !== "")) {
        rejectedRows += 1;
        if (warnings.length < 5) warnings.push(`Record ${record.recordNumber} has non-empty surplus columns`);
        continue;
      }
      record.values = record.values.slice(0, headers.length);
    }
    if (record.values.length !== headers.length) {
      rejectedRows += 1;
      if (warnings.length < 5) warnings.push(`Record ${record.recordNumber} has ${record.values.length} columns; expected ${headers.length}`);
      continue;
    }
    const rawRow: Record<string, string | null> = {};
    headers.forEach((header, index) => { if (header) rawRow[header] = recordValue(record.values, index); });
    const artgId = recordValue(record.values, indexes.artgId);
    const artgName = recordValue(record.values, indexes.artgName);
    const activeIngredients = recordValue(record.values, indexes.activeIngredients);
    const dosageForm = recordValue(record.values, indexes.dosageForm);
    const sponsor = recordValue(record.values, indexes.sponsor);
    if (!artgId || !artgName || !activeIngredients || !dosageForm || !sponsor) {
      rejectedRows += 1;
      if (warnings.length < 5) warnings.push(`Record ${record.recordNumber} is missing an identifying field`);
      continue;
    }
    const values = {
      artgId,
      artgName,
      activeIngredients,
      dosageForm,
      quantityOfActiveIngredients: recordValue(record.values, headerIndex(headers, ["quantity of active ingredients"])),
      sponsor,
      phone: recordValue(record.values, headerIndex(headers, ["phone"])),
      shortageStatus: recordValue(record.values, indexes.shortageStatus),
      supplyImpactStartDate: parseAustralianDate(recordValue(record.values, indexes.supplyImpactStartDate)),
      supplyImpactEndDate: parseAustralianDate(recordValue(record.values, indexes.supplyImpactEndDate)),
      deletionFromMarket: parseAustralianDate(recordValue(record.values, indexes.deletionFromMarket)),
      shortageImpactRating: recordValue(record.values, indexes.shortageImpactRating),
      availability: recordValue(record.values, indexes.availability),
      reason: recordValue(record.values, indexes.reason),
      managementAction: recordValue(record.values, indexes.managementAction),
      lastUpdated: parseAustralianDate(recordValue(record.values, indexes.lastUpdated)),
    };
    const status = shortageStatus(kind, values);
    const episodeDate = values.supplyImpactStartDate ?? values.deletionFromMarket ?? values.supplyImpactEndDate ?? "unknown";
    rows.push({
      sourceRowNumber: record.recordNumber,
      rawRow,
      ...values,
      shortageStatus: status,
      episodeKey: `${values.artgId}:${episodeDate}`,
      canonicalHash: sourceRowHash({ ...values, shortageStatus: status }),
    });
  }
  return {
    headerRecordNumber: headerRecord.recordNumber,
    headers,
    rows,
    rejectedRows,
    warnings,
    reportPublicationDate: parseReportDate(text),
  };
}

type MatchContext = {
  drugs: Array<{ id: number; name: string; activeIngredient: string }>;
  watchedDrugIds: Set<number>;
  watchlistEntryByDrug: Map<number, number>;
  brandsByDrug: Map<number, string[]>;
  artgDrugById: Map<string, number>;
};

async function loadMatchContext(): Promise<MatchContext> {
  const [drugs, watchlist, items, artgEntries] = await Promise.all([
    db.select({ id: drugsTable.id, name: drugsTable.name, activeIngredient: drugsTable.activeIngredient })
      .from(drugsTable).where(eq(drugsTable.authorityScope, runtimeAuthorityScope())).orderBy(asc(drugsTable.id)),
    db.select().from(pbsWatchlistTable).where(eq(pbsWatchlistTable.enabled, true)).orderBy(asc(pbsWatchlistTable.id)),
    db.select({ drugId: pbsItemsTable.drugId, brandName: pbsItemsTable.brandName, itemCode: pbsItemsTable.itemCode })
      .from(pbsItemsTable).where(and(activePbsItemScope(), eq(pbsItemsTable.authorityScope, runtimeAuthorityScope()))),
    db.select({ artgId: artgEntriesTable.artgId, matchedDrugId: artgEntriesTable.matchedDrugId })
      .from(artgEntriesTable).where(sql`${artgEntriesTable.matchedDrugId} IS NOT NULL`),
  ]);
  const brandsByDrug = new Map<number, string[]>();
  for (const item of items) brandsByDrug.set(item.drugId, [...(brandsByDrug.get(item.drugId) ?? []), item.brandName]);
  const watchedDrugIds = new Set<number>();
  const watchlistEntryByDrug = new Map<number, number>();
  for (const drug of drugs) {
    const matchingEntry = watchlist.find((entry) => {
      const filter = normaliseProductForMatch(entry.filterValue);
      if (entry.filterType === "drug_name") {
        return filter === normaliseProductForMatch(drug.name) || filter === normaliseProductForMatch(drug.activeIngredient);
      }
      if (entry.filterType === "brand_name") return (brandsByDrug.get(drug.id) ?? []).some((brand) => normaliseProductForMatch(brand) === filter);
      if (entry.filterType === "pbs_code") return false;
      return false;
    });
    if (matchingEntry) {
      watchedDrugIds.add(drug.id);
      watchlistEntryByDrug.set(drug.id, matchingEntry.id);
    }
  }
  const artgDrugById = new Map<string, number>();
  for (const entry of artgEntries) if (entry.matchedDrugId !== null && watchedDrugIds.has(entry.matchedDrugId)) artgDrugById.set(normaliseProductForMatch(entry.artgId), entry.matchedDrugId);
  return { drugs, watchedDrugIds, watchlistEntryByDrug, brandsByDrug, artgDrugById };
}

function ingredientComponents(value: string): string[] {
  return value.split(/[~;+]/).map((part) => normaliseIngredientForMatch(part)).filter(Boolean);
}

function brandMatches(artgName: string, brand: string): boolean {
  const product = normaliseProductForMatch(artgName);
  const brandKey = normaliseProductForMatch(brand);
  return Boolean(product && brandKey && (product === brandKey || product.startsWith(brandKey)));
}

function matchesForRow(row: TgaParsedRow, context: MatchContext): Array<{
  watchedDrugId: number;
  watchlistEntryId: number | null;
  matchPaths: string[];
  confidence: TgaMatchConfidence;
  diagnosticReason: string;
}> {
  const components = ingredientComponents(row.activeIngredients);
  return [...context.watchedDrugIds].flatMap((drugId) => {
    const drug = context.drugs.find((candidate) => candidate.id === drugId);
    if (!drug) return [];
    const artg = context.artgDrugById.get(normaliseProductForMatch(row.artgId)) === drugId;
    const ingredient = components.some((component) => ingredientContainsWholeWord(component, drug.activeIngredient));
    const brand = (context.brandsByDrug.get(drugId) ?? []).some((candidate) => brandMatches(row.artgName, candidate));
    const paths = [artg ? "artg" : null, ingredient ? "ingredient" : null, brand ? "brand" : null].filter((path): path is string => path !== null);
    if (!paths.length) return [];
    const confidence: TgaMatchConfidence = artg || (ingredient && brand) ? "exact" : ingredient ? "high" : "review";
    return [{
      watchedDrugId: drugId,
      watchlistEntryId: context.watchlistEntryByDrug.get(drugId) ?? null,
      matchPaths: paths,
      confidence,
      diagnosticReason: `Matched via ${paths.join(" + ")} evidence`,
    }];
  });
}

function persistedSourceKey(kind: TgaSourceKind): string {
  return process.env.NODE_ENV === "test" ? `test:${kind === "active" ? TGA_ACTIVE_SOURCE_KEY : TGA_ARCHIVE_SOURCE_KEY}` : kind === "active" ? TGA_ACTIVE_SOURCE_KEY : TGA_ARCHIVE_SOURCE_KEY;
}

async function fetchTgaExport(kind: TgaSourceKind): Promise<{ bytes: Buffer; fileUrl: string; fileName: string; contentType: string | null }> {
  const url = kind === "active" ? TGA_ACTIVE_URL : TGA_ARCHIVE_URL;
  const maxBytes = kind === "active" ? MAX_ACTIVE_BYTES : MAX_ARCHIVE_BYTES;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/csv,text/plain,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok && response.status !== 429 && response.status < 500) throw new Error(`TGA export returned ${response.status} ${response.statusText}`);
      if (!response.ok) throw new Error(`TGA export returned ${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`TGA ${kind} export size is outside the accepted limit`);
      const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 2_000)).replace(/^\uFEFF/, "");
      if (preview.includes("<html") || !preview.includes(",")) throw new Error("TGA response was not CSV-like");
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileName = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1] ?? `tga-${kind}.csv`;
      return { bytes, fileUrl: response.url, fileName: decodeURIComponent(fileName), contentType: response.headers.get("content-type") };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("TGA export fetch failed");
}

async function createFileAttempt(kind: TgaSourceKind, runId: number, source: { bytes: Buffer; fileUrl: string; fileName: string; contentType: string | null }): Promise<number> {
  const sourceKey = persistedSourceKey(kind);
  const [file] = await db.insert(pbsPublishedFilesTable).values({
    sourceKey,
    pageUrl: kind === "active" ? TGA_ACTIVE_URL : TGA_ARCHIVE_URL,
    fileUrl: source.fileUrl,
    fileName: source.fileName,
    contentType: source.contentType,
    fileSha256: createHash("sha256").update(source.bytes).digest("hex"),
    rawContentBase64: source.bytes.toString("base64"),
    ingestionRunId: runId,
    parserVersion: TGA_PARSER_VERSION,
    status: "processing",
    parseHealth: "processing",
    fetchStatus: "succeeded",
    parseStatus: "processing",
    isCurrent: false,
    metadata: { sourceKind: kind },
  }).returning({ id: pbsPublishedFilesTable.id });
  if (!file) throw new Error("Unable to record TGA file attempt");
  return file.id;
}

async function markFileFailed(fileId: number, message: string): Promise<void> {
  await db.update(pbsPublishedFilesTable).set({
    status: "failed", parseHealth: "rejected", parseStatus: "failed", failureStage: "parse",
    errorMessage: message.slice(0, 2_000), metadata: { source: "tga", failure: message.slice(0, 2_000) },
  }).where(eq(pbsPublishedFilesTable.id, fileId));
}

async function ingestTgaSource(kind: TgaSourceKind, runId: number): Promise<{ sourceKey: string; totalRows: number; rejectedRows: number; matchedRows: number }> {
  const source = await fetchTgaExport(kind);
  const fileId = await createFileAttempt(kind, runId, source);
  try {
    const parsed = parseTgaCsv(source.bytes, kind);
    const context = await loadMatchContext();
    let matchedRows = 0;
    for (const row of parsed.rows) {
      const [observation] = await db.insert(tgaShortageObservationsTable).values(withDerivedAuthority(runId, {
        sourceFileId: fileId,
        sourceRowNumber: row.sourceRowNumber,
        sourceKind: kind,
        artgId: row.artgId,
        artgName: row.artgName,
        activeIngredients: row.activeIngredients,
        dosageForm: row.dosageForm,
        quantityOfActiveIngredients: row.quantityOfActiveIngredients,
        sponsor: row.sponsor,
        phone: row.phone,
        shortageStatus: row.shortageStatus,
        supplyImpactStartDate: row.supplyImpactStartDate,
        supplyImpactEndDate: row.supplyImpactEndDate,
        deletionFromMarket: row.deletionFromMarket,
        shortageImpactRating: row.shortageImpactRating,
        availability: row.availability,
        reason: row.reason,
        managementAction: row.managementAction,
        lastUpdated: row.lastUpdated,
        episodeKey: row.episodeKey,
        canonicalHash: row.canonicalHash,
        rawRow: row.rawRow,
      })).returning({ id: tgaShortageObservationsTable.id });
      if (!observation) throw new Error("Unable to persist TGA shortage observation");
      const matches = matchesForRow(row, context);
      if (matches.length) matchedRows += 1;
      for (const match of matches) {
        await db.insert(tgaShortageMatchesTable).values(withDerivedAuthority(runId, {
          observationId: observation.id,
          watchedDrugId: match.watchedDrugId,
          watchlistEntryId: match.watchlistEntryId,
          matchPaths: match.matchPaths,
          confidence: match.confidence,
          matcherVersion: TGA_MATCHER_VERSION,
          diagnosticReason: match.diagnosticReason,
        })).onConflictDoNothing();
      }
    }
    await db.update(pbsPublishedFilesTable).set({
      status: "completed",
      parseHealth: parsed.rejectedRows > Math.max(10, parsed.rows.length * 0.01) ? "degraded" : "healthy",
      parseStatus: "succeeded",
      parsedAt: new Date(),
      reportPublicationDate: parsed.reportPublicationDate,
      totalRows: parsed.rows.length,
      matchedRows,
      rejectedRows: parsed.rejectedRows,
      metadata: { source: "tga", sourceKind: kind, warnings: parsed.warnings, headerRecordNumber: parsed.headerRecordNumber },
      isCurrent: true,
    }).where(eq(pbsPublishedFilesTable.id, fileId));
    await db.update(pbsPublishedFilesTable).set({ isCurrent: false }).where(and(
      eq(pbsPublishedFilesTable.sourceKey, persistedSourceKey(kind)),
      sql`${pbsPublishedFilesTable.id} <> ${fileId}`,
    ));
    return { sourceKey: kind === "active" ? TGA_ACTIVE_SOURCE_KEY : TGA_ARCHIVE_SOURCE_KEY, totalRows: parsed.rows.length, rejectedRows: parsed.rejectedRows, matchedRows };
  } catch (error) {
    await markFileFailed(fileId, error instanceof Error ? error.message : "TGA parse failed");
    throw error;
  }
}

export type TgaIngestionResult = {
  status: "completed" | "failed" | "skipped";
  runId: number;
  completedSources: TgaSourceKind[];
  failedSources: Array<{ source: TgaSourceKind; error: string }>;
};

async function acquireTgaRun(scope: TgaIngestionScope): Promise<{ id: number; newRun: boolean }> {
  const authorityScope = runtimeAuthorityScope();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TGA_LOCK_KEY})`);
    const [activeRun] = await tx.select({ id: ingestionRunsTable.id }).from(ingestionRunsTable)
      .where(and(eq(ingestionRunsTable.mode, "tga_shortages"), inArray(ingestionRunsTable.status, ["queued", "running"]), eq(ingestionRunsTable.authorityScope, authorityScope)))
      .orderBy(desc(ingestionRunsTable.startedAt)).limit(1);
    if (activeRun) return { ...activeRun, newRun: false };
    const [created] = await tx.insert(ingestionRunsTable).values(withGlobalAuthority({
      status: "running", mode: "tga_shortages", scheduleDate: new Date().toISOString().slice(0, 10),
      requestUrls: [scope], snapshotComplete: false,
    }, authorityScope)).returning({ id: ingestionRunsTable.id });
    if (!created) throw new Error("Unable to create TGA ingestion run");
    return { ...created, newRun: true };
  });
}

async function executeTgaRun(runId: number, scope: TgaIngestionScope): Promise<TgaIngestionResult> {
  const completedSources: TgaSourceKind[] = [];
  const failedSources: Array<{ source: TgaSourceKind; error: string }> = [];
  const sources: TgaSourceKind[] = scope === "both" ? ["active", "archive"] : [scope];
  for (const source of sources) {
    try { await ingestTgaSource(source, runId); completedSources.push(source); }
    catch (error) { failedSources.push({ source, error: error instanceof Error ? error.message : "TGA ingestion failed" }); }
  }
  const successful = completedSources.length > 0;
  await db.update(ingestionRunsTable).set({
    status: successful ? "completed" : "failed", finishedAt: new Date(), lastProgressAt: new Date(),
    recordsProcessed: completedSources.length, snapshotComplete: successful,
    errorMessage: failedSources.length ? failedSources.map((failure) => `${failure.source}: ${failure.error}`).join("; ").slice(0, 2_000) : null,
  }).where(eq(ingestionRunsTable.id, runId));
  await ensurePbsSourceRegistry();
  await listPbsSourceStatuses();
  return { status: successful ? "completed" : "failed", runId, completedSources, failedSources };
}

export async function runTgaShortagesIngestion(scope: TgaIngestionScope = "active"): Promise<TgaIngestionResult> {
  const run = await acquireTgaRun(scope);
  if (!run.newRun) return { status: "skipped", runId: run.id, completedSources: [], failedSources: [] };
  return executeTgaRun(run.id, scope);
}

export async function startTgaShortagesIngestion(scope: TgaIngestionScope = "active"): Promise<{ status: "accepted" | "skipped"; runId: number }> {
  const run = await acquireTgaRun(scope);
  if (!run.newRun) return { status: "skipped", runId: run.id };
  setImmediate(() => {
    void executeTgaRun(run.id, scope).catch(async (error) => {
      await db.update(ingestionRunsTable).set({ status: "failed", finishedAt: new Date(), errorMessage: error instanceof Error ? error.message : "TGA ingestion failed" }).where(eq(ingestionRunsTable.id, run.id));
    });
  });
  return { status: "accepted", runId: run.id };
}

function sectionForStatus(status: string | null): TgaShortageSection {
  const normalized = clean(status).toLocaleLowerCase();
  if (normalized.includes("anticipated")) return "anticipated";
  if (normalized.includes("discontinu")) return "discontinued";
  if (normalized.includes("resolv") || normalized.includes("available")) return "resolved";
  return "current";
}

function availabilityRank(value: string | null): number {
  const normalized = clean(value).toLocaleLowerCase();
  if (normalized.includes("emergency")) return 1;
  if (normalized === "unavailable") return 2;
  if (normalized.includes("limited")) return 3;
  if (normalized.includes("reduction")) return 4;
  if (normalized === "available") return 5;
  return 6;
}

export type TgaShortageListParams = {
  mode: "followed" | "all";
  section?: TgaShortageSection;
  availability?: string;
  impactRating?: string;
  watchedDrugId?: number;
  search?: string;
  page: number;
  limit: number;
};

export async function listTgaShortages(params: TgaShortageListParams): Promise<{
  rows: Array<Record<string, unknown>>;
  total: number;
  counts: Record<TgaShortageSection, number>;
  recentlyResolved: Array<Record<string, unknown>>;
  sourceHealth: { active: PbsSourceStatus | null; archive: PbsSourceStatus | null; asOf: string };
}> {
  const activeKey = persistedSourceKey("active");
  const archiveKey = persistedSourceKey("archive");
  const observations = await db.select({
    observation: tgaShortageObservationsTable,
    match: tgaShortageMatchesTable,
    drugName: drugsTable.name,
    activeIngredient: drugsTable.activeIngredient,
    fileRetrievedAt: pbsPublishedFilesTable.retrievedAt,
  }).from(tgaShortageObservationsTable)
    .innerJoin(pbsPublishedFilesTable, eq(tgaShortageObservationsTable.sourceFileId, pbsPublishedFilesTable.id))
    .leftJoin(tgaShortageMatchesTable, eq(tgaShortageMatchesTable.observationId, tgaShortageObservationsTable.id))
    .leftJoin(drugsTable, eq(tgaShortageMatchesTable.watchedDrugId, drugsTable.id))
    .where(and(
      productionAuthorityRun(tgaShortageObservationsTable.authorityRunId),
      inArray(pbsPublishedFilesTable.sourceKey, [activeKey, archiveKey]),
    ))
    .orderBy(desc(tgaShortageObservationsTable.id));
  const currentFileIds = new Set((await db.select({ id: pbsPublishedFilesTable.id }).from(pbsPublishedFilesTable)
    .where(and(eq(pbsPublishedFilesTable.isCurrent, true), inArray(pbsPublishedFilesTable.sourceKey, [activeKey, archiveKey])))).map((file) => file.id));
  const groups = new Map<number, { observation: typeof observations[number]["observation"]; matches: typeof observations[number][]; fileRetrievedAt: Date }>();
  for (const item of observations) {
    if (!currentFileIds.has(item.observation.sourceFileId)) continue;
    const existing = groups.get(item.observation.id);
    if (existing) existing.matches.push(item);
    else groups.set(item.observation.id, { observation: item.observation, matches: [item], fileRetrievedAt: item.fileRetrievedAt });
  }
  const asOf = new Date().toISOString();
  const allRows = [...groups.values()].map((group) => {
    const matches = group.matches.filter((item) => item.match !== null);
    const match = matches[0]?.match ?? null;
    const section = sectionForStatus(group.observation.shortageStatus);
    return {
      id: group.observation.id,
      sourceKind: group.observation.sourceKind,
      artgId: group.observation.artgId,
      artgName: group.observation.artgName,
      activeIngredients: group.observation.activeIngredients,
      dosageForm: group.observation.dosageForm,
      sponsor: group.observation.sponsor,
      shortageStatus: group.observation.shortageStatus,
      section,
      supplyImpactStartDate: group.observation.supplyImpactStartDate,
      supplyImpactEndDate: group.observation.supplyImpactEndDate,
      deletionFromMarket: group.observation.deletionFromMarket,
      shortageImpactRating: group.observation.shortageImpactRating,
      availability: group.observation.availability,
      reason: group.observation.reason,
      managementAction: group.observation.managementAction,
      lastUpdated: group.observation.lastUpdated,
      sourceAsOf: group.fileRetrievedAt.toISOString(),
      followed: Boolean(match),
      watchedDrugId: match?.watchedDrugId ?? null,
      watchedDrugName: matches[0]?.drugName ?? null,
      watchedActiveIngredient: matches[0]?.activeIngredient ?? null,
      matchConfidence: match?.confidence ?? null,
      matchPaths: match?.matchPaths ?? [],
      matchDiagnosticReason: match?.diagnosticReason ?? null,
    };
  });
  const commonFilter = (row: (typeof allRows)[number]) => {
    if (params.mode === "followed" && !row.followed) return false;
    if (params.availability && row.availability !== params.availability) return false;
    if (params.impactRating && row.shortageImpactRating !== params.impactRating) return false;
    if (params.watchedDrugId && row.watchedDrugId !== params.watchedDrugId) return false;
    if (params.search) {
      const haystack = [row.artgId, row.artgName, row.activeIngredients, row.sponsor, row.watchedDrugName ?? ""].join(" ").toLocaleLowerCase();
      if (!haystack.includes(params.search.toLocaleLowerCase())) return false;
    }
    return true;
  };
  const countRows = allRows.filter((row) => row.sourceKind === "active").filter(commonFilter);
  const rows = allRows.filter((row) => {
    if (params.section === "resolved") return row.section === "resolved";
    if (params.section) return row.sourceKind === "active" && row.section === params.section;
    return row.sourceKind === "active" && row.section !== "resolved";
  }).filter(commonFilter);
  rows.sort((left, right) => availabilityRank(Number.isNaN(availabilityRank(left.availability as string | null)) ? null : left.availability as string | null) - availabilityRank(right.availability as string | null)
    || Number(Boolean(right.followed)) - Number(Boolean(left.followed))
    || String(left.artgName).localeCompare(String(right.artgName))
    || Number(left.id) - Number(right.id));
  const counts = (["current", "anticipated", "discontinued", "resolved"] as TgaShortageSection[]).reduce((result, section) => {
    result[section] = countRows.filter((row) => row.section === section).length;
    return result;
  }, {} as Record<TgaShortageSection, number>);
  const recentByEpisode = new Map<string, (typeof allRows)[number]>();
  for (const row of allRows
    .filter((candidate) => candidate.followed && candidate.section === "resolved")
    .filter((candidate) => new Date(String(candidate.supplyImpactEndDate ?? candidate.lastUpdated ?? candidate.sourceAsOf)).getTime() >= Date.now() - 90 * 86_400_000)
    .sort((left, right) => Number(right.sourceKind === "active") - Number(left.sourceKind === "active"))) {
    const key = `${row.artgId}:${row.supplyImpactEndDate ?? row.lastUpdated ?? ""}`;
    if (!recentByEpisode.has(key)) recentByEpisode.set(key, row);
  }
  const recentlyResolved = [...recentByEpisode.values()];
  const sourceHealth = await listPbsSourceStatuses();
  return {
    rows: rows.slice((params.page - 1) * params.limit, params.page * params.limit),
    total: rows.length,
    counts,
    recentlyResolved,
    sourceHealth: {
      active: sourceHealth.find((source) => source.sourceKey === TGA_ACTIVE_SOURCE_KEY) ?? null,
      archive: sourceHealth.find((source) => source.sourceKey === TGA_ARCHIVE_SOURCE_KEY) ?? null,
      asOf,
    },
  };
}