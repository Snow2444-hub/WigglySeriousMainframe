import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import * as XLSX from "xlsx";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import {
  db,
  drugsTable,
  pbsDisclosureCyclesTable,
  pbsFnbReductionsTable,
  pbsItemsTable,
  pbsPublishedFileRowsTable,
  pbsPublishedFilesTable,
  pbsPublishedPricesTable,
  pbsWatchlistTable,
  scheduleChangesTable,
  type PbsPublishedFile,
  runtimeAuthorityScope,
  withDerivedAuthority,
} from "@workspace/db";
import { recalculatePredictedReductionsForAllDrugs } from "./predicted-reductions";
import { activePbsItemScope } from "./pbs-item-lifecycle";
import {
  CANONICAL_PUBLISHED_SOURCE_KEYS,
  ensurePbsSourceRegistry,
  refreshPbsSourceRegistryStatus,
  type PublishedSourceKey,
} from "./pbs-source-status";

const PARSER_VERSION = "pbs-published-files-v1";
const USER_AGENT = "pharmacy-pbs-manager/1.0";
const PAGE_TIMEOUT_MS = 30_000;
const TEST_SOURCE_KEY_PREFIX = "test:";
const MAX_STORED_ERROR_LENGTH = 2_000;
const MAX_OUTER_ERROR_LENGTH = 1_200;
const MAX_DATABASE_DETAIL_LENGTH = 500;
const MAX_CAUSE_DEPTH = 4;

const PAGE_URLS = {
  anniversaryPriceReductions: "https://www.pbs.gov.au/industry/pricing/anniversary-price-reductions",
  firstNewBrand: "https://www.pbs.gov.au/industry/pricing/pbs-items/first-new-brand-price-reductions",
  subjectToPriceDisclosure:
    "https://www.pbs.gov.au/industry/pricing/price-disclosure-spd/drugs-subject-to-price-disclosure",
  currentPriceDisclosureCycle:
    "https://www.pbs.gov.au/industry/pricing/price-disclosure-spd/current-price-disclosure-cycle",
} as const;

type JsonRecord = Record<string, unknown>;

export type PublishedMatchFailure = {
  rowNumber: number;
  sourceDrugName: string | null;
  sourceMoa: string | null;
  sourceItemCode: string | null;
  reason: string;
};

export type PublishedFileReport = {
  sourceKey: PublishedSourceKey;
  status: "completed" | "failed";
  fileUrl: string | null;
  fileName: string | null;
  totalRows: number;
  matchedRows: number;
  watchlistUnmatchedRows: number;
  watchlistFailures: PublishedMatchFailure[];
  errorMessage?: string;
};

export type PublishedIngestionReport = {
  fetchedAt: string;
  files: PublishedFileReport[];
};

type DrugContext = {
  drugs: Array<{ id: number; name: string; activeIngredient: string }>;
  items: Array<{
    itemCode: string;
    pbsCode: string | null;
    liItemId: string | null;
    drugId: number;
    form: string | null;
    liForm: string | null;
    programCode: string | null;
    formulary: "F1" | "F2";
  }>;
  watchlist: Array<{
    id: number;
    filterType: "brand_name" | "drug_name" | "pbs_code" | "formulary" | "program_code" | "atc_code";
    filterValue: string;
  }>;
};

type WorkbookRows = {
  sheetName: string;
  title: string;
  headers: string[];
  rows: Array<{ rowNumber: number; values: unknown[]; record: JsonRecord }>;
  sheet: XLSX.WorkSheet;
  headerRowIndex: number;
  yellowRowNumbers: Set<number>;
};

type SourceFile = {
  sourceKey: PublishedSourceKey;
  pageUrl: string;
  fileUrl: string;
  fileName: string;
  contentType: string | null;
  bytes: Buffer;
  workbook: XLSX.WorkBook;
};

function persistedSourceKey(sourceKey: PublishedSourceKey): string {
  return process.env.NODE_ENV === "test"
    ? `${TEST_SOURCE_KEY_PREFIX}${sourceKey}`
    : sourceKey;
}

export const PUBLISHED_REPORT_MAX_AGE_DAYS = 180;

function sourcePageUrl(sourceKey: PublishedSourceKey): string {
  if (sourceKey === "anniversary_indicative" || sourceKey === "section_99acp") return PAGE_URLS.anniversaryPriceReductions;
  if (sourceKey === "first_new_brand") return PAGE_URLS.firstNewBrand;
  if (sourceKey === "subject_to_price_disclosure") return PAGE_URLS.subjectToPriceDisclosure;
  if (
    sourceKey === "indicative_non_efc" ||
    sourceKey === "indicative_efc" ||
    sourceKey === "confirmed_non_efc" ||
    sourceKey === "confirmed_efc"
  ) {
    return PAGE_URLS.currentPriceDisclosureCycle;
  }
  return "https://www.pbs.gov.au/industry/pricing";
}

export function sourcePriority(sourceKey: string, confidence?: string | null): number {
  if (sourceKey.startsWith("confirmed_") || confidence === "confirmed") return 2;
  if (sourceKey.startsWith("indicative_") || confidence === "indicative") return 1;
  return 0;
}

function dateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function ageInDays(asOf: string, today: string): number {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
}

export function isPublishedReportFresh(
  report: Pick<PbsPublishedFile, "status" | "parseHealth" | "retrievedAt" | "reportPublicationDate">,
  today = new Date().toISOString().slice(0, 10),
): boolean {
  if (report.status !== "completed" || report.parseHealth !== "healthy") return false;
  const asOf = report.reportPublicationDate ?? dateOnly(report.retrievedAt);
  if (!asOf) return false;
  const age = ageInDays(asOf, today);
  return age >= 0 && age <= PUBLISHED_REPORT_MAX_AGE_DAYS;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalized(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function textValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function scalarValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}

function headerKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function findHeader(headers: string[], pattern: RegExp): string | undefined {
  return headers.find((header) => pattern.test(headerKey(header)));
}

export function anniversaryFileLinkMatches(link: { text: string; href: string }): boolean {
  return /^indicative pricing\s*[-–—]\s*anniversary price reductions\s*[-–—]\s*fed\b/i.test(link.text);
}

export function section99acpFileLinkMatches(link: { text: string; href: string }): boolean {
  return /^indicative pricing\s+s\.\s*99acp anniversary list for\s+\d{4}\.xlsx\b/i.test(link.text);
}

function moaMatches(localForm: string | null, sourceMoa: string): boolean {
  const local = normalized(localForm);
  const source = normalized(sourceMoa);
  if (!local || !source) return false;
  if (local === source || local.startsWith(`${source} `)) return true;
  const routeForms: Record<string, RegExp> = {
    oral: /^(tablet|capsule|caplet|oral|solution|suspension|granules?|powder|wafer|lozenge|chewable)\b/,
    injection: /^(injection|infusion|implant)\b/,
    inhalation: /^(inhalation|pressurised|nebuliser|nebulizer)\b/,
    topical: /^(cream|ointment|gel|lotion|patch|topical)\b/,
    ophthalmic: /^(eye|ophthalmic)\b/,
    otic: /^(ear|otic)\b/,
    nasal: /^(nasal|spray)\b/,
  };
  return Boolean(routeForms[source]?.test(local));
}

function recordValue(record: JsonRecord, pattern: RegExp): unknown {
  const key = Object.keys(record).find((candidate) => pattern.test(headerKey(candidate)));
  return key ? record[key] : undefined;
}

function parseAnchors(html: string, baseUrl: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const re = /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const text = match[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    try {
      links.push({
        text,
        href: new URL(match[2].replaceAll("&amp;", "&"), baseUrl).href,
      });
    } catch {
      // Ignore malformed navigation links; file links must still be validated below.
    }
  }
  return [...new Map(links.map((link) => [link.href, link])).values()];
}

async function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
}

function chooseFileLink(
  links: Array<{ text: string; href: string }>,
  predicate: (link: { text: string; href: string }) => boolean,
): string | undefined {
  return links.find(
    (link) => /\.(xlsx?|xlsm|csv)(?:[?#]|$)/i.test(link.href) && predicate(link),
  )?.href;
}

async function fetchSourceFile(
  sourceKey: PublishedSourceKey,
  pageUrl: string,
  predicate: (link: { text: string; href: string }) => boolean,
): Promise<SourceFile> {
  const pageResponse = await fetchWithTimeout(pageUrl);
  const html = await pageResponse.text();
  if (!pageResponse.ok) {
    throw new Error(`PBS page returned ${pageResponse.status} ${pageResponse.statusText}`);
  }
  const links = parseAnchors(html, pageResponse.url);
  const fileUrl = chooseFileLink(links, predicate);
  if (!fileUrl) throw new Error("No spreadsheet download link was found in the PBS page HTML");

  const fileResponse = await fetchWithTimeout(fileUrl);
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (!fileResponse.ok) {
    throw new Error(`PBS file returned ${fileResponse.status} ${fileResponse.statusText}`);
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: "buffer",
      cellDates: true,
      cellStyles: true,
      raw: false,
    });
  } catch (error) {
    throw new Error(`Downloaded PBS file is not a readable workbook: ${publishedFileErrorMessage(error)}`);
  }

  return {
    sourceKey,
    pageUrl,
    fileUrl: fileResponse.url,
    fileName: decodeURIComponent(new URL(fileResponse.url).pathname.split("/").pop() ?? "pbs-published-file"),
    contentType: fileResponse.headers.get("content-type"),
    bytes,
    workbook,
  };
}

function workbookYellowRows(workbook: XLSX.WorkBook, bytes: Buffer): Set<number> {
  const rows = new Set<number>();
  try {
    const moduleRequire = createRequire(import.meta.url);
    const xlsxPath = moduleRequire.resolve("xlsx");
    const cfbPath = moduleRequire.resolve("cfb", { paths: [dirname(xlsxPath)] });
    const cfb = moduleRequire(cfbPath) as {
      read: (content: Buffer, options: { type: "buffer" }) => { Directory: unknown; FullPaths: string[] };
      find: (container: { FullPaths: string[] }, path: string) => { content: Uint8Array } | undefined;
    };
    const zip = cfb.read(bytes, { type: "buffer" });
    const directory = (workbook as XLSX.WorkBook & {
      Directory?: { sheets?: string[]; styles?: string };
    }).Directory;
    const sheetPath = directory?.sheets?.[0] ?? "/xl/worksheets/sheet1.xml";
    const stylesPath = directory?.styles ?? "/xl/styles.xml";
    const sheetEntry = cfb.find(zip, `Root Entry${sheetPath}`);
    const stylesEntry = cfb.find(zip, `Root Entry${stylesPath}`);
    if (!sheetEntry || !stylesEntry) return rows;
    const sheetXml = new TextDecoder().decode(sheetEntry.content);
    const stylesXml = new TextDecoder().decode(stylesEntry.content);
    const fillsXml = stylesXml.match(/<fills\b[^>]*>([\s\S]*?)<\/fills>/i)?.[1] ?? "";
    const yellowFillIds = new Set<number>();
    [...fillsXml.matchAll(/<fill\b[^>]*>([\s\S]*?)<\/fill>/gi)].forEach((match, fillId) => {
      const rgb = match[1].match(/<fgColor\b[^>]*\brgb="([A-F0-9]+)"/i)?.[1]?.toUpperCase();
      if (rgb === "FFFFFF00" || rgb === "FFFF00") yellowFillIds.add(fillId);
    });
    const cellXfsXml = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i)?.[1] ?? "";
    const yellowStyleIds = new Set<number>();
    [...cellXfsXml.matchAll(/<xf\b([^>]*)\/?>/gi)].forEach((match, styleId) => {
      const fillId = Number(match[1].match(/\bfillId="(\d+)"/i)?.[1]);
      if (yellowFillIds.has(fillId)) yellowStyleIds.add(styleId);
    });
    for (const cellMatch of sheetXml.matchAll(/<c\b([^>]*)>/gi)) {
      const attributes = cellMatch[1];
      const rowNumber = Number(attributes.match(/\br="[^"]+?(\d+)"/i)?.[1]);
      const styleId = Number(attributes.match(/\bs="(\d+)"/i)?.[1]);
      if (Number.isInteger(rowNumber) && yellowStyleIds.has(styleId)) rows.add(rowNumber);
    }
  } catch {
    // Style metadata is optional for other published files; matching remains auditable without it.
  }
  return rows;
}

function workbookRows(
  workbook: XLSX.WorkBook,
  bytes: Buffer,
  headerRowIndex: number,
  requestedSheetName?: string,
): WorkbookRows {
  const sheetName = requestedSheetName ?? workbook.SheetNames[0];
  if (!sheetName) throw new Error("PBS workbook did not contain a worksheet");
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
    raw: false,
  });
  const headers = (rawRows[headerRowIndex] ?? []).map((value) => textValue(value) ?? "");
  const title = rawRows[0]?.map((value) => textValue(value) ?? "").join(" ").trim() ?? "";
  const rows = rawRows
    .slice(headerRowIndex + 1)
    .map((values, index) => {
      const record: JsonRecord = {};
      headers.forEach((header, columnIndex) => {
        if (header) record[header] = scalarValue(values[columnIndex]);
      });
      return { rowNumber: headerRowIndex + index + 2, values, record };
    })
    .filter(({ record }) => Object.values(record).some((value) => value !== null && String(value).trim() !== ""));
  return {
    sheetName,
    title,
    headers,
    rows,
    sheet,
    headerRowIndex,
    yellowRowNumbers: sheetName === workbook.SheetNames[0] ? workbookYellowRows(workbook, bytes) : new Set<number>(),
  };
}

type AnniversaryWorkbookSheet = {
  sheetName: string;
  parsed: WorkbookRows;
  effectiveDate: string;
  drugHeader: string;
  formHeader: string;
  brandHeader: string;
};

function anniversaryWorkbookSheets(sourceFile: SourceFile): AnniversaryWorkbookSheet[] {
  return sourceFile.workbook.SheetNames.map((sheetName) => {
    const parsed = workbookRows(sourceFile.workbook, sourceFile.bytes, 1, sheetName);
    const drugHeader = findHeader(parsed.headers, /legal instrument drug/i);
    const formHeader = findHeader(parsed.headers, /legal instrument form/i);
    const brandHeader = findHeader(parsed.headers, /^brand name$/i);
    const currentAempHeader = findHeader(parsed.headers, /^aemp as at/i);
    const proposedAempHeader = findHeader(parsed.headers, /^proposed aemp as at/i);
    if (!drugHeader || !formHeader || !brandHeader || !currentAempHeader || !proposedAempHeader) {
      throw new Error(`Anniversary workbook sheet "${sheetName}" is missing a required column`);
    }
    const effectiveDate = extractReductionDate(parsed.title) ?? extractReductionDate(proposedAempHeader);
    if (!effectiveDate) {
      throw new Error(`Anniversary workbook sheet "${sheetName}" has no proposed AEMP date`);
    }
    return { sheetName, parsed, effectiveDate, drugHeader, formHeader, brandHeader };
  });
}

function anniversaryPublicationDate(sheets: AnniversaryWorkbookSheet[]): string | null {
  const years = sheets
    .map((sheet) => Number(sheet.effectiveDate.slice(0, 4)))
    .filter((year) => Number.isInteger(year));
  return years.length ? `${Math.min(...years) - 1}-08-01` : null;
}

export function inspectAnniversaryWorkbook(workbook: XLSX.WorkBook, bytes: Buffer): {
  publicationDate: string | null;
  sheets: Array<{ sheetName: string; headers: string[]; rowCount: number; effectiveDate: string }>;
} {
  const sourceFile = {
    sourceKey: "anniversary_indicative" as const,
    pageUrl: PAGE_URLS.anniversaryPriceReductions,
    fileUrl: PAGE_URLS.anniversaryPriceReductions,
    fileName: "inspection.xlsx",
    contentType: null,
    bytes,
    workbook,
  };
  const sheets = anniversaryWorkbookSheets(sourceFile);
  return {
    publicationDate: anniversaryPublicationDate(sheets),
    sheets: sheets.map((sheet) => ({
      sheetName: sheet.sheetName,
      headers: sheet.parsed.headers,
      rowCount: sheet.parsed.rows.length,
      effectiveDate: sheet.effectiveDate,
    })),
  };
}

function extractReductionDate(value: string): string | null {
  const match = value.match(
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i,
  );
  return match ? dateValue(`${match[1]} ${match[2]} ${match[3]}`) : null;
}

function extractCycle(value: string): {
  cycleCode: string;
  cycleLabel: string;
  submissionDeadline: string;
} | null {
  const cycle = value.match(/\b(20\d{2})\s+(April|October)\s+Cycle\b/i);
  if (!cycle) return null;
  const month = cycle[2].toLowerCase() === "april" ? "04" : "10";
  const deadline = value.match(
    /deadline:\s*(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
  );
  const submissionDeadline = dateValue(deadline?.[1] ?? "");
  if (!submissionDeadline) return null;
  return {
    cycleCode: `${cycle[1]}-${month}`,
    cycleLabel: `${cycle[2]} ${cycle[1]} cycle`,
    submissionDeadline,
  };
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function databaseErrorDetails(error: unknown): string[] {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!isRecord(current) || seen.has(current)) break;
    seen.add(current);

    const code = boundedText(current.code, 5);
    if (code && /^[A-Z0-9]{5}$/i.test(code)) details.push(`SQLSTATE ${code}`);

    const constraint = boundedText(current.constraint, 128);
    if (constraint && /^[A-Z0-9_.-]+$/i.test(constraint)) {
      details.push(`constraint ${constraint}`);
    }

    const detail = boundedText(current.detail, MAX_DATABASE_DETAIL_LENGTH);
    if (detail) details.push(`detail ${detail}`);

    if (details.length > 0) break;
    current = current.cause;
  }

  return details;
}

export function publishedFileErrorMessage(error: unknown): string {
  const outerMessage =
    boundedText(error instanceof Error ? error.message : isRecord(error) ? error.message : error, MAX_OUTER_ERROR_LENGTH) ??
    "Unknown error";
  return [outerMessage, ...databaseErrorDetails(error)].join("; ").slice(0, MAX_STORED_ERROR_LENGTH);
}

async function loadContext(): Promise<DrugContext> {
  const authorityScope = runtimeAuthorityScope();
  const [drugs, items, watchlist] = await Promise.all([
    db
      .select({ id: drugsTable.id, name: drugsTable.name, activeIngredient: drugsTable.activeIngredient })
      .from(drugsTable)
      .where(eq(drugsTable.authorityScope, authorityScope))
      .orderBy(asc(drugsTable.id)),
    db
      .select({
        itemCode: pbsItemsTable.itemCode,
        pbsCode: pbsItemsTable.pbsCode,
        liItemId: pbsItemsTable.liItemId,
        drugId: pbsItemsTable.drugId,
        form: pbsItemsTable.form,
        liForm: pbsItemsTable.liForm,
        programCode: pbsItemsTable.programCode,
        formulary: pbsItemsTable.formulary,
      })
      .from(pbsItemsTable)
       .where(and(activePbsItemScope(), eq(pbsItemsTable.authorityScope, authorityScope)))
      .orderBy(asc(pbsItemsTable.itemCode)),
    db
      .select({
        id: pbsWatchlistTable.id,
        filterType: pbsWatchlistTable.filterType,
        filterValue: pbsWatchlistTable.filterValue,
      })
      .from(pbsWatchlistTable)
      .where(eq(pbsWatchlistTable.enabled, true))
      .orderBy(asc(pbsWatchlistTable.id)),
  ]);
  return { drugs, items, watchlist };
}

function matchDrugAndMoa(
  context: DrugContext,
  sourceDrugName: string | null,
  sourceMoa: string | null,
): { drugId: number | null; itemCodes: string[]; reason: string | null } {
  const drugKey = normalized(sourceDrugName);
  const moaKey = normalized(sourceMoa);
  if (!drugKey) return { drugId: null, itemCodes: [], reason: "Source drug name is blank" };
  if (!moaKey) return { drugId: null, itemCodes: [], reason: "Source manner of administration is blank" };

  const drug = context.drugs.find(
    (candidate) =>
      normalized(candidate.name) === drugKey || normalized(candidate.activeIngredient) === drugKey,
  );
  if (!drug) {
    return { drugId: null, itemCodes: [], reason: `No local drug matched "${sourceDrugName}"` };
  }
  const matchedItems = context.items.filter(
    (item) =>
      item.drugId === drug.id &&
      (moaMatches(item.form, moaKey) || moaMatches(item.liForm, moaKey)),
  );
  if (matchedItems.length === 0) {
    return {
      drugId: drug.id,
      itemCodes: [],
      reason: `Drug matched, but no local item has MoA "${sourceMoa}"`,
    };
  }
  return { drugId: drug.id, itemCodes: matchedItems.map((item) => item.itemCode), reason: null };
}

function watchedRow(
  context: DrugContext,
  row: { drugName: string | null; moa: string | null; itemCode: string | null; brandName?: string | null; programCode?: string | null },
): boolean {
  return context.watchlist.some((entry) => {
    const filter = normalized(entry.filterValue);
    switch (entry.filterType) {
      case "drug_name":
        return normalized(row.drugName) === filter;
      case "brand_name":
        return Boolean(row.brandName && normalized(row.brandName).includes(filter));
      case "pbs_code":
        return normalized(row.itemCode) === filter;
      case "program_code":
        return normalized(row.programCode) === filter;
      default:
        return false;
    }
  });
}

async function upsertPublishedFile(sourceFile: SourceFile, ingestionRunId?: number): Promise<PbsPublishedFile> {
  const fileSha256 = createHash("sha256").update(sourceFile.bytes).digest("hex");
  const sourceKey = persistedSourceKey(sourceFile.sourceKey);
  await db
    .update(pbsPublishedFilesTable)
    .set({ isCurrent: false })
    .where(eq(pbsPublishedFilesTable.sourceKey, sourceKey));
  const [file] = await db
    .insert(pbsPublishedFilesTable)
    .values({
      sourceKey,
      pageUrl: sourceFile.pageUrl,
      fileUrl: sourceFile.fileUrl,
      fileName: sourceFile.fileName,
      contentType: sourceFile.contentType,
      fileSha256,
      rawContentBase64: sourceFile.bytes.toString("base64"),
      reportPublicationDate: null,
      effectiveDate: null,
      parserVersion: PARSER_VERSION,
      status: "processing",
      parseHealth: "processing",
      fetchStatus: "succeeded",
      parseStatus: "processing",
      failureStage: null,
      parsedAt: null,
      ingestionRunId: ingestionRunId ?? null,
      metadata: { sheetNames: sourceFile.workbook.SheetNames },
      isCurrent: true,
    })
    .returning();
  if (!file) throw new Error(`Unable to persist ${sourceFile.sourceKey} file metadata`);
  return file;
}

async function clearFileRows(fileId: number): Promise<void> {
  await db.delete(pbsPublishedFileRowsTable).where(eq(pbsPublishedFileRowsTable.fileId, fileId));
  await db.delete(pbsDisclosureCyclesTable).where(eq(pbsDisclosureCyclesTable.fileId, fileId));
  await db.delete(pbsFnbReductionsTable).where(eq(pbsFnbReductionsTable.fileId, fileId));
  await db.delete(pbsPublishedPricesTable).where(eq(pbsPublishedPricesTable.fileId, fileId));
  await db
    .delete(scheduleChangesTable)
    .where(
      and(
        eq(scheduleChangesTable.changeType, "published_fnb_new"),
        like(scheduleChangesTable.liItemId, `published-fnb:${fileId}:%`),
      ),
    );
}

export function publishedFileParseOutcome(
  totalRows: number,
  parseHealthOverride?: "healthy" | "rejected",
): {
  parseHealth: "healthy" | "rejected";
  parseStatus: "succeeded" | "failed";
  failureStage: "parse" | null;
  errorMessage: string | null;
} {
  const parseHealth = parseHealthOverride ?? (totalRows > 0 ? "healthy" : "rejected");
  const errorMessage = parseHealth === "rejected"
    ? "Parsed workbook contained no data rows"
    : null;
  return {
    parseHealth,
    parseStatus: parseHealth === "healthy" ? "succeeded" : "failed",
    failureStage: parseHealth === "healthy" ? null : "parse",
    errorMessage,
  };
}

async function finishPublishedFile(
  fileId: number,
  result: Omit<PublishedFileReport, "sourceKey" | "fileUrl" | "fileName" | "status">,
  provenance: { reportPublicationDate: string | null; effectiveDate: string | null },
  parseHealthOverride?: "healthy" | "rejected",
): Promise<void> {
  const outcome = publishedFileParseOutcome(result.totalRows, parseHealthOverride);
  await db
    .update(pbsPublishedFilesTable)
    .set({
      status: "completed",
      parseHealth: outcome.parseHealth,
      parsedAt: new Date(),
      fetchStatus: "succeeded",
      parseStatus: outcome.parseStatus,
      failureStage: outcome.failureStage,
      reportPublicationDate: provenance.reportPublicationDate,
      effectiveDate: provenance.effectiveDate,
      totalRows: result.totalRows,
      matchedRows: result.matchedRows,
      rejectedRows: Math.max(0, result.totalRows - result.matchedRows),
      watchlistUnmatchedRows: result.watchlistUnmatchedRows,
      errorMessage: outcome.errorMessage,
      metadata: {
        watchlistFailures: result.watchlistFailures,
        parseHealth: outcome.parseHealth,
        rejectedRows: Math.max(0, result.totalRows - result.matchedRows),
        ...(outcome.errorMessage ? { failure: outcome.errorMessage } : {}),
      },
    })
    .where(eq(pbsPublishedFilesTable.id, fileId));
}

async function failPublishedFile(fileId: number, message: string): Promise<void> {
  await db
    .update(pbsPublishedFilesTable)
    .set({
      status: "failed",
      parseHealth: "rejected",
      fetchStatus: "succeeded",
      parseStatus: "failed",
      failureStage: "parse",
      rejectedRows: 0,
      errorMessage: message.slice(0, 2_000),
      metadata: { parseHealth: "rejected", failure: message.slice(0, 2_000) },
    })
    .where(eq(pbsPublishedFilesTable.id, fileId));
}

async function recordFailedPublishedFile(sourceKey: PublishedSourceKey, message: string): Promise<void> {
  const storageSourceKey = persistedSourceKey(sourceKey);
  await db
    .update(pbsPublishedFilesTable)
    .set({ isCurrent: false })
    .where(eq(pbsPublishedFilesTable.sourceKey, storageSourceKey));
  const pageUrl = sourcePageUrl(sourceKey);
  const fileSha256 = createHash("sha256").update(`${sourceKey}:${message}`).digest("hex");
  await db.insert(pbsPublishedFilesTable).values({
    sourceKey: storageSourceKey,
    pageUrl,
    fileUrl: pageUrl,
    fileName: `${sourceKey}-unavailable`,
    contentType: null,
    fileSha256,
    rawContentBase64: "",
    parserVersion: PARSER_VERSION,
    status: "failed",
    parseHealth: "rejected",
    fetchStatus: "failed",
    parseStatus: "not_attempted",
    failureStage: "fetch",
    errorMessage: message.slice(0, 2_000),
    metadata: { parseHealth: "rejected", failure: message.slice(0, 2_000) },
    isCurrent: true,
  });
}

async function persistFileRow(input: {
  fileId: number;
  rowNumber: number;
  rawRow: JsonRecord;
  sourceDrugName: string | null;
  sourceMoa: string | null;
  sourceItemCode: string | null;
  matchedDrugId: number | null;
  matchedItemCodes: string[];
  matchStatus: "matched" | "unmatched";
  failureReason: string | null;
  isWatchlistMatch: boolean;
  isNewEntry?: boolean;
  effectDate?: string | null;
}): Promise<void> {
  await db.insert(pbsPublishedFileRowsTable).values({
    fileId: input.fileId,
    sourceRowNumber: input.rowNumber,
    rawRow: input.rawRow,
    sourceDrugName: input.sourceDrugName,
    sourceMoa: input.sourceMoa,
    sourceItemCode: input.sourceItemCode,
    matchedDrugId: input.matchedDrugId,
    matchedItemCodes: input.matchedItemCodes,
    matchStatus: input.matchStatus,
    failureReason: input.failureReason,
    isWatchlistMatch: input.isWatchlistMatch,
    isNewEntry: input.isNewEntry ?? false,
    effectDate: input.effectDate ?? null,
  });
}

async function processFirstNewBrand(
  sourceFile: SourceFile,
  file: PbsPublishedFile,
  context: DrugContext,
  authorityRunId?: number,
): Promise<PublishedFileReport> {
  const parsed = workbookRows(sourceFile.workbook, sourceFile.bytes, 0);
  const dataRows = parsed.rows.filter(({ record }) => {
    const drug = textValue(recordValue(record, /^drug$/i));
    return Boolean(drug && !drug.startsWith("("));
  });
  let matchedRows = 0;
  const watchlistFailures: PublishedMatchFailure[] = [];
  for (const row of dataRows) {
    const sourceDrugName = textValue(recordValue(row.record, /^drug$/i));
    const sourceMoa = textValue(recordValue(row.record, /manner of administration/i));
    const effectDate = dateValue(recordValue(row.record, /date of effect/i));
    const match = matchDrugAndMoa(context, sourceDrugName, sourceMoa);
    const isNewEntry = parsed.yellowRowNumbers.has(row.rowNumber);
    const reason = effectDate ? match.reason : "Date of effect is missing or invalid";
    const isMatched = !reason && match.itemCodes.length > 0 && match.drugId !== null;
    const isWatched = watchedRow(context, { drugName: sourceDrugName, moa: sourceMoa, itemCode: null });
    if (isMatched) {
      matchedRows += 1;
      await db
        .insert(pbsFnbReductionsTable)
        .values({
          fileId: file.id,
          sourceRowNumber: row.rowNumber,
          drugId: match.drugId as number,
          sourceDrugName: sourceDrugName as string,
          mannerOfAdministration: sourceMoa as string,
          effectDate: effectDate as string,
          isNewEntry,
        })
        .onConflictDoUpdate({
          target: [
            pbsFnbReductionsTable.drugId,
            pbsFnbReductionsTable.mannerOfAdministration,
            pbsFnbReductionsTable.effectDate,
          ],
          set: {
            fileId: file.id,
            sourceRowNumber: row.rowNumber,
            sourceDrugName: sourceDrugName as string,
            isNewEntry,
          },
        });
      if (isNewEntry) {
        await db
          .insert(scheduleChangesTable)
          .values(withDerivedAuthority(authorityRunId ?? file.ingestionRunId!, {
            scheduleCode: 0,
            effectiveDate: effectDate as string,
            changeType: "published_fnb_new",
            liItemId: `published-fnb:${file.id}:${row.rowNumber}`,
            pbsCode: null,
            drugId: match.drugId as number,
            brandName: null,
            oldValue: null,
            newValue: {
              source: "first_new_brand",
              drug_name: sourceDrugName,
              manner_of_administration: sourceMoa,
              date_of_effect: effectDate,
              matched_item_codes: match.itemCodes,
              is_new_entry: true,
            },
            affectedItems: null,
            significance: "normal",
            notes: "New row highlighted in the PBS First New Brand Price Reductions register.",
          }))
          .onConflictDoNothing();
      }
    }
    await persistFileRow({
      fileId: file.id,
      rowNumber: row.rowNumber,
      rawRow: row.record,
      sourceDrugName,
      sourceMoa,
      sourceItemCode: null,
      matchedDrugId: match.drugId,
      matchedItemCodes: match.itemCodes,
      matchStatus: isMatched ? "matched" : "unmatched",
      failureReason: reason,
      isWatchlistMatch: isWatched,
      isNewEntry,
      effectDate,
    });
    if (!isMatched && isWatched) {
      watchlistFailures.push({
        rowNumber: row.rowNumber,
        sourceDrugName,
        sourceMoa,
        sourceItemCode: null,
        reason: reason ?? "No local item matched",
      });
    }
  }

  const result = {
    totalRows: dataRows.length,
    matchedRows,
    watchlistUnmatchedRows: watchlistFailures.length,
    watchlistFailures,
  };
  await finishPublishedFile(file.id, result, {
    reportPublicationDate: dateOnly(file.retrievedAt),
    effectiveDate: result.totalRows > 0 ? dataRows.map((row) => dateValue(recordValue(row.record, /date of effect/i))).find(Boolean) ?? null : null,
  });
  return {
    sourceKey: sourceFile.sourceKey,
    status: "completed",
    fileUrl: sourceFile.fileUrl,
    fileName: sourceFile.fileName,
    ...result,
  };
}

async function processSubjectToPriceDisclosure(
  sourceFile: SourceFile,
  file: PbsPublishedFile,
  context: DrugContext,
): Promise<PublishedFileReport> {
  const parsed = workbookRows(sourceFile.workbook, sourceFile.bytes, 0);
  const cycleHeaders = parsed.headers
    .map((header, index) => ({ header, index, cycle: extractCycle(header) }))
    .filter((candidate): candidate is { header: string; index: number; cycle: NonNullable<typeof candidate.cycle> } =>
      Boolean(candidate.cycle),
    );
  if (cycleHeaders.length === 0) throw new Error("No disclosure-cycle columns were found in the subject list");

  let matchedRows = 0;
  const watchlistFailures: PublishedMatchFailure[] = [];
  for (const row of parsed.rows) {
    const sourceDrugName = textValue(recordValue(row.record, /legal instrument drug/i));
    const sourceMoa = textValue(recordValue(row.record, /legal instrument moa/i));
    const match = matchDrugAndMoa(context, sourceDrugName, sourceMoa);
    const isMatched = match.drugId !== null && match.itemCodes.length > 0;
    const isWatched = watchedRow(context, { drugName: sourceDrugName, moa: sourceMoa, itemCode: null });
    if (isMatched) {
      matchedRows += 1;
      for (const cycleHeader of cycleHeaders) {
        const subject = textValue(row.values[cycleHeader.index]);
        if (subject?.toLowerCase() !== "yes") continue;
        await db
          .insert(pbsDisclosureCyclesTable)
          .values({
            fileId: file.id,
            sourceRowNumber: row.rowNumber,
            drugId: match.drugId as number,
            legalInstrumentDrug: sourceDrugName as string,
            legalInstrumentMoa: sourceMoa as string,
            cycleCode: cycleHeader.cycle.cycleCode,
            cycleLabel: cycleHeader.cycle.cycleLabel,
            submissionDeadline: cycleHeader.cycle.submissionDeadline,
          })
          .onConflictDoUpdate({
            target: [pbsDisclosureCyclesTable.drugId, pbsDisclosureCyclesTable.cycleCode],
            set: {
              fileId: file.id,
              sourceRowNumber: row.rowNumber,
              legalInstrumentDrug: sourceDrugName as string,
              legalInstrumentMoa: sourceMoa as string,
              cycleLabel: cycleHeader.cycle.cycleLabel,
              submissionDeadline: cycleHeader.cycle.submissionDeadline,
            },
          });
      }
    }
    const reason = isMatched ? null : match.reason ?? "No local item matched";
    await persistFileRow({
      fileId: file.id,
      rowNumber: row.rowNumber,
      rawRow: row.record,
      sourceDrugName,
      sourceMoa,
      sourceItemCode: null,
      matchedDrugId: match.drugId,
      matchedItemCodes: match.itemCodes,
      matchStatus: isMatched ? "matched" : "unmatched",
      failureReason: reason,
      isWatchlistMatch: isWatched,
    });
    if (!isMatched && isWatched) {
      watchlistFailures.push({
        rowNumber: row.rowNumber,
        sourceDrugName,
        sourceMoa,
        sourceItemCode: null,
        reason: reason as string,
      });
    }
  }
  const result = {
    totalRows: parsed.rows.length,
    matchedRows,
    watchlistUnmatchedRows: watchlistFailures.length,
    watchlistFailures,
  };
  await finishPublishedFile(file.id, result, {
    reportPublicationDate: dateOnly(file.retrievedAt),
    effectiveDate: cycleHeaders.map((header) => `${header.cycle.cycleCode}-01`).sort()[0] ?? null,
  });
  return {
    sourceKey: sourceFile.sourceKey,
    status: "completed",
    fileUrl: sourceFile.fileUrl,
    fileName: sourceFile.fileName,
    ...result,
  };
}

async function processAnniversaryIndicative(
  sourceFile: SourceFile,
  file: PbsPublishedFile,
  context: DrugContext,
): Promise<PublishedFileReport> {
  const sheets = anniversaryWorkbookSheets(sourceFile);
  let totalRows = 0;
  let matchedRows = 0;
  const watchlistFailures: PublishedMatchFailure[] = [];

  for (const [sheetIndex, sheet] of sheets.entries()) {
    for (const row of sheet.parsed.rows) {
      totalRows += 1;
      const sourceDrugName = textValue(row.record[sheet.drugHeader]);
      const sourceMoa = textValue(row.record[sheet.formHeader]);
      const brandName = textValue(row.record[sheet.brandHeader]);
      const match = matchDrugAndMoa(context, sourceDrugName, sourceMoa);
      const isMatched = match.drugId !== null && match.itemCodes.length > 0;
      const isWatched = watchedRow(context, {
        drugName: sourceDrugName,
        moa: sourceMoa,
        itemCode: null,
        brandName,
      });
      const reason = isMatched ? null : match.reason ?? "No local item matched";
      const sourceRowNumber = sheetIndex * 100_000 + row.rowNumber;

      if (isMatched) matchedRows += 1;
      await persistFileRow({
        fileId: file.id,
        rowNumber: sourceRowNumber,
        rawRow: { ...row.record, _sheetName: sheet.sheetName },
        sourceDrugName,
        sourceMoa,
        sourceItemCode: null,
        matchedDrugId: match.drugId,
        matchedItemCodes: match.itemCodes,
        matchStatus: isMatched ? "matched" : "unmatched",
        failureReason: reason,
        isWatchlistMatch: isWatched,
        effectDate: sheet.effectiveDate,
      });
      if (!isMatched && isWatched) {
        watchlistFailures.push({
          rowNumber: sourceRowNumber,
          sourceDrugName,
          sourceMoa,
          sourceItemCode: null,
          reason: reason ?? "No local item matched",
        });
      }
    }
  }

  const result = { totalRows, matchedRows, watchlistUnmatchedRows: watchlistFailures.length, watchlistFailures };
  await finishPublishedFile(
    file.id,
    result,
    {
      reportPublicationDate: anniversaryPublicationDate(sheets),
      effectiveDate: sheets.map((sheet) => sheet.effectiveDate).sort()[0] ?? null,
    },
    "healthy",
  );
  return {
    sourceKey: sourceFile.sourceKey,
    status: "completed",
    fileUrl: sourceFile.fileUrl,
    fileName: sourceFile.fileName,
    ...result,
  };
}

function indicativeDate(parsed: WorkbookRows): string {
  const date =
    extractReductionDate(parsed.title) ??
    extractReductionDate(parsed.headers.find((header) => /new .*aemp/i.test(header)) ?? "");
  if (!date) throw new Error("Could not determine the indicative reduction date from workbook headers");
  return date;
}

function reportPublicationDate(parsed: WorkbookRows, file: PbsPublishedFile): string | null {
  const reportDate = [parsed.title, ...parsed.headers]
    .map((value) => value.match(
      /\b(?:publication|published|report)\s*(?:date|on)?\s*:?\s*(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/i,
    )?.[1])
    .map((value) => (value ? dateValue(value) : null))
    .find((value): value is string => value !== null);
  return reportDate ?? dateOnly(file.retrievedAt);
}

async function processIndicativePrices(
  sourceFile: SourceFile,
  file: PbsPublishedFile,
  context: DrugContext,
): Promise<PublishedFileReport> {
  const parsed = workbookRows(sourceFile.workbook, sourceFile.bytes, 1);
  const itemCodeHeader = findHeader(parsed.headers, /^item code$/);
  const drugHeader = findHeader(parsed.headers, /legal instrument drug/);
  const moaHeader = findHeader(parsed.headers, /legal instrument moa/);
  const brandHeader = findHeader(parsed.headers, /^brand name$/);
  const currentAempHeader = findHeader(parsed.headers, /^current .*aemp/);
  const newAempHeader = findHeader(parsed.headers, /^new .*aemp/);
  if (!itemCodeHeader || !drugHeader || !moaHeader || !brandHeader || !currentAempHeader || !newAempHeader) {
    throw new Error("Indicative workbook is missing one or more required row-2 headers");
  }
  const predictedDate = indicativeDate(parsed);
  const confidence = sourceFile.sourceKey.startsWith("confirmed_") ? "confirmed" : "indicative";
  const priority = sourcePriority(sourceFile.sourceKey, confidence);
  let matchedRows = 0;
  const watchlistFailures: PublishedMatchFailure[] = [];
  for (const row of parsed.rows) {
    const sourceItemCode = textValue(row.record[itemCodeHeader]);
    const sourceDrugName = textValue(row.record[drugHeader]);
    const sourceMoa = textValue(row.record[moaHeader]);
    const brandName = textValue(row.record[brandHeader]);
    const currentAemp = numberValue(row.record[currentAempHeader]);
    const newAemp = numberValue(row.record[newAempHeader]);
    const localItems = context.items.filter((item) =>
      [item.itemCode, item.pbsCode, item.liItemId].some(
        (candidate) => normalized(candidate) === normalized(sourceItemCode),
      ),
    );
    const matchedItemCodes = [...new Set(localItems.map((item) => item.itemCode))];
    const matchedDrugId = localItems[0]?.drugId ?? null;
    const reason = !sourceItemCode
      ? "Source Item Code is blank"
      : matchedItemCodes.length === 0
        ? `No local PBS item matched Item Code "${sourceItemCode}"`
        : currentAemp === null || newAemp === null
          ? "Current or new AEMP is missing or invalid"
          : null;
    const isMatched = !reason && matchedItemCodes.length > 0 && matchedDrugId !== null;
    const isWatched = watchedRow(context, {
      drugName: sourceDrugName,
      moa: sourceMoa,
      itemCode: sourceItemCode,
      brandName,
      programCode: textValue(recordValue(row.record, /program code/i)),
    });
    if (isMatched) {
      matchedRows += 1;
      const percentage =
        currentAemp && currentAemp > 0
          ? Number((((currentAemp - (newAemp as number)) / currentAemp) * 100).toFixed(3))
          : 0;
      for (const matchedItemCode of matchedItemCodes) {
        await db.insert(pbsPublishedPricesTable).values({
          fileId: file.id,
          sourceRowNumber: row.rowNumber,
          sourceItemCode: sourceItemCode as string,
          matchedItemCode,
          drugId: matchedDrugId as number,
          legalInstrumentDrug: sourceDrugName ?? "",
          legalInstrumentMoa: sourceMoa ?? "",
          brandName: brandName ?? "",
          currentAemp: currentAemp as number,
          newAemp: newAemp as number,
          predictedDate,
          confidence,
          sourcePriority: priority,
        });
      }
    }
    const failureReason = reason;
    await persistFileRow({
      fileId: file.id,
      rowNumber: row.rowNumber,
      rawRow: row.record,
      sourceDrugName,
      sourceMoa,
      sourceItemCode,
      matchedDrugId,
      matchedItemCodes,
      matchStatus: isMatched ? "matched" : "unmatched",
      failureReason,
      isWatchlistMatch: isWatched,
    });
    if (!isMatched && isWatched) {
      watchlistFailures.push({
        rowNumber: row.rowNumber,
        sourceDrugName,
        sourceMoa,
        sourceItemCode,
        reason: failureReason ?? "No local item matched",
      });
    }
  }
  const result = {
    totalRows: parsed.rows.length,
    matchedRows,
    watchlistUnmatchedRows: watchlistFailures.length,
    watchlistFailures,
  };
  await finishPublishedFile(file.id, result, {
    reportPublicationDate: reportPublicationDate(parsed, file),
    effectiveDate: predictedDate,
  });
  return {
    sourceKey: sourceFile.sourceKey,
    status: "completed",
    fileUrl: sourceFile.fileUrl,
    fileName: sourceFile.fileName,
    ...result,
  };
}

async function processSource(
  sourceKey: PublishedSourceKey,
  fetchSource: () => Promise<SourceFile>,
  context: DrugContext,
  ingestionRunId?: number,
): Promise<PublishedFileReport> {
  let sourceFile: SourceFile | undefined;
  let file: PbsPublishedFile | undefined;
  try {
    sourceFile = await fetchSource();
    file = await upsertPublishedFile(sourceFile, ingestionRunId);
    await clearFileRows(file.id);
    if (sourceKey === "anniversary_indicative" || sourceKey === "section_99acp") {
      return await processAnniversaryIndicative(sourceFile, file, context);
    }
    if (sourceKey === "first_new_brand") return await processFirstNewBrand(sourceFile, file, context, ingestionRunId);
    if (sourceKey === "subject_to_price_disclosure") {
      return await processSubjectToPriceDisclosure(sourceFile, file, context);
    }
    return await processIndicativePrices(sourceFile, file, context);
  } catch (error) {
    const message = publishedFileErrorMessage(error);
    if (file) {
      await failPublishedFile(file.id, message);
    } else {
      await recordFailedPublishedFile(sourceKey, message);
    }
    return {
      sourceKey,
      status: "failed",
      fileUrl: sourceFile?.fileUrl ?? null,
      fileName: sourceFile?.fileName ?? null,
      totalRows: 0,
      matchedRows: 0,
      watchlistUnmatchedRows: 0,
      watchlistFailures: [],
      errorMessage: message,
    };
  }
}

export type PublishedIngestionOptions = {
  sourceKeys?: readonly PublishedSourceKey[];
};

export async function ingestPublishedFiles(
  ingestionRunId?: number,
  options: PublishedIngestionOptions = {},
): Promise<PublishedIngestionReport> {
  if (ingestionRunId === undefined) {
    throw new Error("Published-file ingestion requires an authoritative ingestion run.");
  }
  const context = await loadContext();
  await ensurePbsSourceRegistry();
  const sourceProcessors: Array<{
    sourceKey: PublishedSourceKey;
    run: () => Promise<PublishedFileReport>;
  }> = [
    {
      sourceKey: "anniversary_indicative",
      run: () =>
        processSource(
          "anniversary_indicative",
          () =>
            fetchSourceFile(
              "anniversary_indicative",
              PAGE_URLS.anniversaryPriceReductions,
              anniversaryFileLinkMatches,
            ),
          context,
          ingestionRunId,
        ),
    },
    {
      sourceKey: "section_99acp",
      run: () =>
        processSource(
          "section_99acp",
          () =>
            fetchSourceFile(
              "section_99acp",
              PAGE_URLS.anniversaryPriceReductions,
              section99acpFileLinkMatches,
            ),
          context,
          ingestionRunId,
        ),
    },
    {
      sourceKey: "first_new_brand",
      run: () =>
        processSource(
          "first_new_brand",
          () =>
            fetchSourceFile("first_new_brand", PAGE_URLS.firstNewBrand, (link) =>
              /first new brand|price reductions/i.test(`${link.text} ${link.href}`),
            ),
          context,
          ingestionRunId,
        ),
    },
    {
      sourceKey: "subject_to_price_disclosure",
      run: () =>
        processSource(
          "subject_to_price_disclosure",
          () =>
            fetchSourceFile(
              "subject_to_price_disclosure",
              PAGE_URLS.subjectToPriceDisclosure,
              (link) => /subject to price disclosure/i.test(`${link.text} ${link.href}`),
            ),
          context,
          ingestionRunId,
        ),
    },
    {
      sourceKey: "indicative_non_efc",
      run: () =>
        processSource(
          "indicative_non_efc",
          () =>
            fetchSourceFile(
              "indicative_non_efc",
              PAGE_URLS.currentPriceDisclosureCycle,
              (link) => /indicative prices report/i.test(link.text) && /excluding efc/i.test(link.text),
            ),
          context,
          ingestionRunId,
        ),
    },
    {
      sourceKey: "indicative_efc",
      run: () =>
        processSource(
          "indicative_efc",
          () =>
            fetchSourceFile(
              "indicative_efc",
              PAGE_URLS.currentPriceDisclosureCycle,
              (link) => /indicative prices report/i.test(link.text) && /efc drugs only/i.test(link.text),
            ),
          context,
          ingestionRunId,
        ),
    },
    {
      sourceKey: "confirmed_non_efc",
      run: () =>
        processSource(
          "confirmed_non_efc",
          () =>
            fetchSourceFile(
              "confirmed_non_efc",
              PAGE_URLS.currentPriceDisclosureCycle,
              (link) => /confirmed prices report/i.test(link.text) && /excluding efc/i.test(link.text),
            ),
          context,
          ingestionRunId,
        ),
    },
    {
      sourceKey: "confirmed_efc",
      run: () =>
        processSource(
          "confirmed_efc",
          () =>
            fetchSourceFile(
              "confirmed_efc",
              PAGE_URLS.currentPriceDisclosureCycle,
              (link) => /confirmed prices report/i.test(link.text) && /efc drugs only/i.test(link.text),
            ),
          context,
          ingestionRunId,
        ),
    },
  ];
  const selectedSources = options.sourceKeys ? new Set(options.sourceKeys) : null;
  const files = await Promise.all(
    selectedSources
      ? sourceProcessors.filter((processor) => selectedSources.has(processor.sourceKey)).map((processor) => processor.run())
      : sourceProcessors.map((processor) => processor.run()),
  );
  await refreshPbsSourceRegistryStatus();
  await recalculatePredictedReductionsForAllDrugs(undefined, ingestionRunId);
  return { fetchedAt: new Date().toISOString(), files };
}

export async function listLatestPublishedFiles(): Promise<Array<PbsPublishedFile & {
  watchlistFailures: PublishedMatchFailure[];
}>> {
  const files = await db
    .select()
    .from(pbsPublishedFilesTable)
    .where(
      and(
        eq(pbsPublishedFilesTable.isCurrent, true),
        inArray(pbsPublishedFilesTable.sourceKey, CANONICAL_PUBLISHED_SOURCE_KEYS),
      ),
    )
    .orderBy(asc(pbsPublishedFilesTable.sourceKey));
  return files.map((file) => ({
    ...file,
    watchlistFailures: Array.isArray(file.metadata) ? [] : isRecord(file.metadata) && Array.isArray(file.metadata.watchlistFailures)
      ? file.metadata.watchlistFailures.filter(isRecord).map((failure) => ({
          rowNumber: typeof failure.rowNumber === "number" ? failure.rowNumber : 0,
          sourceDrugName: typeof failure.sourceDrugName === "string" ? failure.sourceDrugName : null,
          sourceMoa: typeof failure.sourceMoa === "string" ? failure.sourceMoa : null,
          sourceItemCode: typeof failure.sourceItemCode === "string" ? failure.sourceItemCode : null,
          reason: typeof failure.reason === "string" ? failure.reason : "Unknown matching failure",
        }))
      : [],
  }));
}