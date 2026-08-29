import * as XLSX from "xlsx";

export const ARTG_PARSER_VERSION = "1";

type SourceRow = Record<string, unknown>;

export type TrackedDrug = {
  id: number;
  name: string;
  activeIngredient: string;
};

export type ParsedArtgRecord = {
  artgId: string;
  activeIngredient: string;
  normalizedIngredient: string;
  matchedDrugId: number;
  sponsor: string;
  registrationDate: string;
  productName: string;
  status: string;
};

export type ArtgParseResult = {
  rowsRead: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsSkipped: number;
  matchedDrugRecords: number;
  warnings: string[];
  records: ParsedArtgRecord[];
};

const HEADER_ALIASES = {
  artgId: ["artg id", "artg number", "artg no", "artg identifier"],
  activeIngredient: ["active ingredient", "active ingredients", "ingredient", "ingredients", "generic name"],
  sponsor: ["sponsor", "sponsor name"],
  registrationDate: ["start date", "registration date", "artg start date", "date of registration"],
  productName: ["product name", "good name", "trade name", "medicine name"],
  status: ["status", "artg status", "entry status", "registration status"],
  productType: ["product type"],
} as const;

const SALT_WORDS = new Set([
  "acetate", "calcium", "citrate", "hydrochloride", "hydrobromide", "maleate", "mesylate",
  "monohydrate", "phosphate", "potassium", "sodium", "succinate", "sulfate", "tartrate",
]);

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normaliseHeader(value: unknown): string {
  return cleanText(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normaliseStatus(value: unknown): string {
  const normalized = cleanText(value).toLocaleUpperCase();
  if (!normalized) return "REGISTERED";
  if (normalized.includes("CANCEL")) return "CANCELLED";
  if (normalized.includes("REGISTER")) return "REGISTERED";
  return normalized;
}

export function normaliseIngredient(value: string): string {
  return cleanText(value)
    .toLocaleLowerCase()
    .replace(/[()[\],]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !SALT_WORDS.has(word))
    .join(" ");
}

function normaliseIngredientForMatch(value: string): string {
  return cleanText(value)
    .toLocaleLowerCase()
    .replace(/[()[\],.;:+/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findHeader(headers: Map<string, string>, aliases: readonly string[]): string | undefined {
  return aliases.map(normaliseHeader).map((alias) => headers.get(alias)).find(Boolean);
}

function dateString(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  if (/^\d{5,}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (Number.isFinite(serial) && serial >= 1 && serial <= 2_958_465) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000));
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }
  }
  const australianDate = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (australianDate) {
    const day = Number(australianDate[1]);
    const month = Number(australianDate[2]);
    const year = Number(australianDate[3].length === 2 ? `20${australianDate[3]}` : australianDate[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? date.toISOString().slice(0, 10)
      : null;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function matchedDrug(ingredient: string, drugs: TrackedDrug[]): TrackedDrug | undefined {
  const candidate = normaliseIngredientForMatch(ingredient);
  if (!candidate) return undefined;
  const candidateWords = ` ${candidate} `;
  return drugs.find((drug) => {
    const key = normaliseIngredientForMatch(normaliseIngredient(drug.activeIngredient));
    return Boolean(key && candidateWords.includes(` ${key} `));
  });
}

function parseWorkbook(buffer: Buffer, fileName: string): SourceRow[] {
  const extension = fileName.toLocaleLowerCase().split(".").at(-1);
  if (!extension || !["csv", "xlsx", "xls"].includes(extension)) {
    throw new Error("Upload a .csv, .xlsx, or .xls file exported from the TGA ARTG search.");
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    throw new Error("The upload could not be read as a CSV or Excel workbook.");
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The upload did not contain a worksheet.");
  const rows = XLSX.utils.sheet_to_json<SourceRow>(workbook.Sheets[sheetName], { defval: "", raw: false });
  if (!rows.length) {
    const headings = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, blankrows: false })[0];
    if (!headings?.length) throw new Error("The upload did not contain ARTG headers or data rows.");
  }
  return rows;
}

export function parseArtgExport(buffer: Buffer, fileName: string, drugs: TrackedDrug[]): ArtgParseResult {
  const rows = parseWorkbook(buffer, fileName);
  const headers = new Map<string, string>();
  for (const row of rows) {
    Object.keys(row).forEach((header) => headers.set(normaliseHeader(header), header));
  }
  if (!headers.size) {
    throw new Error("The ARTG export has no data rows. Export at least the header row and one result before uploading.");
  }

  const artgIdHeader = findHeader(headers, HEADER_ALIASES.artgId);
  const ingredientHeader = findHeader(headers, HEADER_ALIASES.activeIngredient);
  const sponsorHeader = findHeader(headers, HEADER_ALIASES.sponsor);
  const registrationDateHeader = findHeader(headers, HEADER_ALIASES.registrationDate);
  const productNameHeader = findHeader(headers, HEADER_ALIASES.productName);
  const statusHeader = findHeader(headers, HEADER_ALIASES.status);
  const productTypeHeader = findHeader(headers, HEADER_ALIASES.productType);
  const missing = [
    !artgIdHeader && "ARTG ID",
    !ingredientHeader && "Active ingredient",
    !sponsorHeader && "Sponsor",
    !registrationDateHeader && "Start/registration date",
    !productNameHeader && "Product/good name",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`The ARTG export is missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Export the medicine details that include active ingredient and registration date.`);
  }
  if (!artgIdHeader || !ingredientHeader || !sponsorHeader || !registrationDateHeader || !productNameHeader) {
    throw new Error("The ARTG export has invalid headers.");
  }

  const warnings: string[] = [];
  const records = new Map<string, ParsedArtgRecord>();
  let rejected = 0;
  let skipped = 0;
  let compositeSkipped = 0;
  let unmatchedSkipped = 0;
  for (const [index, row] of rows.entries()) {
    const artgId = cleanText(row[artgIdHeader]);
    const activeIngredient = cleanText(row[ingredientHeader]);
    const sponsor = cleanText(row[sponsorHeader]);
    const productName = cleanText(row[productNameHeader]);
    const registrationDate = dateString(row[registrationDateHeader]);
    const productType = productTypeHeader ? cleanText(row[productTypeHeader]) : "";
    const hasNumericArtgId = /^\d+$/.test(artgId);
    const hasRecordContent = Boolean(activeIngredient || sponsor || productName || registrationDate);
    if (!hasNumericArtgId && !hasRecordContent) {
      continue;
    }
    if (
      normaliseHeader(productType) === "composite pack" &&
      hasNumericArtgId &&
      !activeIngredient &&
      sponsor &&
      productName &&
      registrationDate
    ) {
      skipped += 1;
      compositeSkipped += 1;
      if (warnings.length < 20) {
        warnings.push(`Row ${index + 2} was skipped deliberately: composite pack has no active ingredient on this row.`);
      }
      continue;
    }
    if (!artgId || !activeIngredient || !sponsor || !productName || !registrationDate) {
      rejected += 1;
      const missingFields = [
        !artgId && "ARTG ID",
        !activeIngredient && "Active ingredient",
        !sponsor && "Sponsor",
        !productName && "Product name",
        !registrationDate && "Start/registration date",
      ].filter(Boolean);
      if (warnings.length < 20) {
        warnings.push(`Row ${index + 2} was skipped because required ARTG field${missingFields.length === 1 ? "" : "s"} ${missingFields.join(", ")} ${missingFields.length === 1 ? "was" : "were"} blank or invalid.`);
      }
      continue;
    }
    const drug = matchedDrug(activeIngredient, drugs);
    if (!drug) {
      skipped += 1;
      unmatchedSkipped += 1;
      continue;
    }
    records.set(artgId, {
      artgId,
      activeIngredient,
      normalizedIngredient: normaliseIngredient(activeIngredient),
      matchedDrugId: drug.id,
      sponsor,
      registrationDate,
      productName,
      status: normaliseStatus(statusHeader ? row[statusHeader] : ""),
    });
  }
  if (rejected) warnings.push(`${rejected} row${rejected === 1 ? "" : "s"} could not be imported because required ARTG values were missing or invalid.`);
  if (compositeSkipped) {
    warnings.push(`${compositeSkipped} composite-pack row${compositeSkipped === 1 ? "" : "s"} were skipped deliberately because the active ingredient is listed on component rows.`);
  }
  if (unmatchedSkipped) {
    warnings.push(`${unmatchedSkipped} row${unmatchedSkipped === 1 ? "" : "s"} did not match an active tracked ingredient and were not added.`);
  }
  return {
    rowsRead: rows.length,
    recordsAccepted: records.size,
    recordsRejected: rejected,
    recordsSkipped: skipped,
    matchedDrugRecords: records.size,
    warnings,
    records: [...records.values()],
  };
}

export function normaliseProductForMatch(value: string): string {
  return cleanText(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function pbsBrandMatchesArtgProduct(productName: string, brandName: string): boolean {
  const product = normaliseProductForMatch(productName);
  const brand = normaliseProductForMatch(brandName);
  return brand.length >= 3 && (product.includes(brand) || brand.includes(product));
}

export function shouldReplaceLegacySeedRecords(recordsAccepted: number): boolean {
  return recordsAccepted > 0;
}