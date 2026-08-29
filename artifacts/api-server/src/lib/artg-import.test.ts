import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  normaliseIngredient,
  parseArtgExport,
  pbsBrandMatchesArtgProduct,
  shouldReplaceLegacySeedRecords,
} from "./artg-import";

const trackedDrugs = [
  { id: 1, name: "Rosuvastatin", activeIngredient: "Rosuvastatin calcium" },
  { id: 2, name: "Rivaroxaban", activeIngredient: "Rivaroxaban" },
];

test("parses TGA CSV columns, normalises ingredients, and retains registered status", () => {
  const csv = [
    "ARTG ID,Active Ingredient,Sponsor Name,Start Date,Good Name,Status",
    "401234,Rosuvastatin calcium,Generic Health,15/01/2024,Actavanz 10 mg tablets,Registered",
    "401235,Rivaroxaban,Example Pharma,01/02/2024,Rivaroxaban Example tablets,Cancelled",
    "401236,Untracked ingredient,Other Pharma,01/02/2024,Other medicine,Registered",
  ].join("\n");
  const result = parseArtgExport(Buffer.from(csv), "tga-artg-export.csv", trackedDrugs);

  assert.equal(result.rowsRead, 3);
  assert.equal(result.recordsAccepted, 2);
  assert.equal(result.recordsRejected, 0);
  assert.equal(result.recordsSkipped, 1);
  assert.equal(result.records[0]?.registrationDate, "2024-01-15");
  assert.equal(result.records[0]?.matchedDrugId, 1);
  assert.equal(result.records[0]?.status, "REGISTERED");
  assert.equal(result.records[1]?.status, "CANCELLED");
  assert.equal(normaliseIngredient("Rosuvastatin calcium"), "rosuvastatin");
});

test("rejects a changed ARTG export that omits required ingredient evidence", () => {
  const csv = [
    "ARTG ID,Sponsor Name,Start Date,Good Name",
    "401234,Generic Health,15/01/2024,Actavanz 10 mg tablets",
  ].join("\n");
  assert.throws(
    () => parseArtgExport(Buffer.from(csv), "tga-artg-export.csv", trackedDrugs),
    /Active ingredient/,
  );
});

test("parses a valid XLSX ARTG export", () => {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["ARTG Number", "Generic Name", "Sponsor", "Date of Registration", "Product Name", "ARTG Status"],
    ["401237", "Rosuvastatin calcium", "Generic Health", "2024-03-01", "Rosuvastatin tablets", "Registered"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "ARTG export");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const result = parseArtgExport(buffer, "tga-artg-export.xlsx", trackedDrugs);
  assert.equal(result.recordsAccepted, 1);
  assert.equal(result.records[0]?.artgId, "401237");
  assert.equal(result.records[0]?.registrationDate, "2024-03-01");
});

test("matches tracked ingredients contained as whole words in ARTG text", () => {
  const csv = [
    "ARTG ID,Active Ingredient,Sponsor Name,Start Date,Good Name,Status",
    "401239,lisdexamfetamine dimesilate,Example Pharma,01/04/2024,Lisdexamfetamine medicine,Registered",
    "401240,rivaroxaban (as rivaroxaban),Example Pharma,02/04/2024,Rivaroxaban medicine,Registered",
    "401241,rosuvastatin calcium,Example Pharma,03/04/2024,Actavanz 10 mg tablets,Registered",
    "401242,rivaroxabanine,Example Pharma,04/04/2024,Unrelated medicine,Registered",
  ].join("\n");
  const result = parseArtgExport(Buffer.from(csv), "tga-artg-export.csv", [
    { id: 10, name: "Lisdexamfetamine", activeIngredient: "Lisdexamfetamine" },
    { id: 11, name: "Rivaroxaban", activeIngredient: "Rivaroxaban" },
    { id: 12, name: "Rosuvastatin", activeIngredient: "Rosuvastatin" },
  ]);

  assert.equal(result.recordsAccepted, 3);
  assert.equal(result.recordsRejected, 0);
  assert.equal(result.recordsSkipped, 1);
  assert.deepEqual(result.records.map((record) => [record.artgId, record.matchedDrugId]), [
    ["401239", 10],
    ["401240", 11],
    ["401241", 12],
  ]);
});

test("converts Excel serial dates and ignores composite/footer rows without counting them invalid", () => {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["ARTG Number", "Generic Name", "Sponsor", "Date of Registration", "Product Name", "ARTG Status", "Product Type"],
    ["401238", "Rosuvastatin calcium", "Generic Health", 46245, "Rosuvastatin tablets", "Registered", "Single Medicine Product"],
    ["523373", "", "GlaxoSmithKline Australia Pty Ltd", 46245, "AREXVY vaccine", "Registered", "Composite Pack"],
    ["Applied filters: Approval Area is Prescription or Over-the-Counter", "", "", "", "", "", ""],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "ARTG export");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const result = parseArtgExport(buffer, "tga-artg-export.xlsx", trackedDrugs);
  assert.equal(result.recordsAccepted, 1);
  assert.equal(result.recordsRejected, 0);
  assert.equal(result.recordsSkipped, 1);
  assert.equal(result.records[0]?.registrationDate, "2026-08-11");
  assert.match(result.warnings[0] ?? "", /composite pack/);
  assert.ok(result.warnings.every((warning) => !warning.includes("could not be imported")));
});

test("matches PBS brands conservatively and never clears legacy data on zero accepted records", () => {
  assert.equal(pbsBrandMatchesArtgProduct("ACTAVANZ 10 mg tablets", "Actavanz"), true);
  assert.equal(pbsBrandMatchesArtgProduct("Rivaroxaban Example tablets", "Xarelto"), false);
  assert.equal(shouldReplaceLegacySeedRecords(0), false);
  assert.equal(shouldReplaceLegacySeedRecords(1), true);
});