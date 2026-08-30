import assert from "node:assert/strict";
import { test } from "node:test";
import * as XLSX from "xlsx";
import {
  anniversaryFileLinkMatches,
  inspectAnniversaryWorkbook,
  isPublishedReportFresh,
  section99acpFileLinkMatches,
  sourcePriority,
} from "./pbs-published-files";

function report(overrides: Partial<{
  status: string;
  parseHealth: string;
  retrievedAt: Date;
  reportPublicationDate: string | null;
}> = {}) {
  return {
    status: "completed",
    parseHealth: "healthy",
    retrievedAt: new Date("2026-01-01T00:00:00.000Z"),
    reportPublicationDate: "2026-01-01",
    ...overrides,
  } as Parameters<typeof isPublishedReportFresh>[0];
}

test("confirmed reports take precedence over indicative reports", () => {
  assert.equal(sourcePriority("confirmed_non_efc", "confirmed"), 2);
  assert.equal(sourcePriority("indicative_non_efc", "indicative"), 1);
  assert.equal(sourcePriority("legacy", "conditional"), 0);
});

test("published reports expire at the configured maximum age", () => {
  assert.equal(isPublishedReportFresh(report(), "2026-06-30"), true);
  assert.equal(isPublishedReportFresh(report(), "2026-07-01"), false);
  assert.equal(isPublishedReportFresh(report({ parseHealth: "rejected" }), "2026-06-30"), false);
  assert.equal(isPublishedReportFresh(report({ status: "failed" }), "2026-06-30"), false);
  assert.equal(isPublishedReportFresh(report(), "2025-12-31"), false);
});

function anniversaryWorkbook(sheets: Array<{ name: string; title: string; proposedDate: string }>) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        [sheet.title],
        [
          "F1 Legal Instrument Drug",
          "Legal Instrument Form",
          "Brand Name",
          "Responsible Person",
          "AEMP as at 1 July 2026",
          `Proposed AEMP as at ${sheet.proposedDate}`,
        ],
        ["Example drug", "Tablet 10 mg", "Example", "Example Pty Ltd", "$10.00", "$9.50"],
      ]),
      sheet.name,
    );
  }
  return { workbook, bytes: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })) };
}

test("anniversary and 99ACP links select the current Excel labels", () => {
  assert.equal(
    anniversaryFileLinkMatches({
      text: "Indicative pricing – Anniversary Price Reductions – FED – 1 April 2027.xlsx (Excel 20.7KB)",
      href: "https://www.pbs.gov.au/current.xlsx",
    }),
    true,
  );
  assert.equal(
    anniversaryFileLinkMatches({
      text: "Excel version – Five Year F1 5% Statutory Price Reduction - 1 April 2026 Indicative Pricing",
      href: "https://www.pbs.gov.au/old.xlsx",
    }),
    false,
  );
  assert.equal(
    section99acpFileLinkMatches({
      text: "Indicative pricing s. 99ACP Anniversary List for 2027.xlsx (Excel 14KB)",
      href: "https://www.pbs.gov.au/current-99acp.xlsx",
    }),
    true,
  );
  assert.equal(
    section99acpFileLinkMatches({
      text: "Indicative pricing s. 99ACP Anniversary List from 1 April 2025 onwards.xlsx",
      href: "https://www.pbs.gov.au/old-99acp.xlsx",
    }),
    false,
  );
});

test("anniversary workbook inspection handles multi-sheet 1 April lists", () => {
  const { workbook, bytes } = anniversaryWorkbook([
    {
      name: "s99ACHB Indicative list",
      title: "Five year Anniversary Price Reduction under section 99ACHB",
      proposedDate: "1 April 2027",
    },
    {
      name: "s99ACJA Indicative list",
      title: "Ten year Anniversary Price Reduction under section 99ACJA",
      proposedDate: "1 April 2027",
    },
  ]);
  const inspected = inspectAnniversaryWorkbook(workbook, bytes);
  assert.equal(inspected.publicationDate, "2026-08-01");
  assert.deepEqual(
    inspected.sheets.map((sheet) => [sheet.sheetName, sheet.rowCount, sheet.effectiveDate]),
    [
      ["s99ACHB Indicative list", 1, "2027-04-01"],
      ["s99ACJA Indicative list", 1, "2027-04-01"],
    ],
  );
  assert.deepEqual(inspected.sheets[0]?.headers.slice(0, 3), [
    "F1 Legal Instrument Drug",
    "Legal Instrument Form",
    "Brand Name",
  ]);
});

test("anniversary workbook inspection derives 99ACP publication and sheet dates", () => {
  const { workbook, bytes } = anniversaryWorkbook([
    { name: "Indicative August 2027", title: "Section 99ACP indicative pricing", proposedDate: "1 August 2027" },
    { name: "Indicative October 2027", title: "Section 99ACP indicative pricing", proposedDate: "1 October 2027" },
    { name: "Indicative December 2027", title: "Section 99ACP indicative pricing", proposedDate: "1 December 2027" },
  ]);
  const inspected = inspectAnniversaryWorkbook(workbook, bytes);
  assert.equal(inspected.publicationDate, "2026-08-01");
  assert.deepEqual(
    inspected.sheets.map((sheet) => sheet.effectiveDate),
    ["2027-08-01", "2027-10-01", "2027-12-01"],
  );
});