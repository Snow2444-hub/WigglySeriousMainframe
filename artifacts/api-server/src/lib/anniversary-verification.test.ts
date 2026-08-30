import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANNIVERSARY_PERCENTAGE_TOLERANCE,
  buildAnniversaryVerification,
  impliedReductionPercentage,
  resolveAnniversaryRow,
  type AnniversaryCatalogueItem,
  type AnniversaryPrediction,
  type AnniversaryPublishedRow,
} from "./anniversary-verification";

const row = (overrides: Partial<AnniversaryPublishedRow> = {}): AnniversaryPublishedRow => ({
  id: 1,
  fileId: 10,
  sourceRowNumber: 4,
  sourceDrugName: "Apixaban",
  sourceMoa: "Tablet 5 mg",
  rawRow: {
    "F1 Legal Instrument Drug": "Apixaban",
    "Legal Instrument Form": "Tablet 5 mg",
    "Brand Name": "Eliquis",
    "AEMP as at 1 July 2026": "$100.00",
    "Proposed AEMP as at 1 April 2027": "$95.00",
  },
  effectDate: "2027-04-01",
  ...overrides,
});

const item = (overrides: Partial<AnniversaryCatalogueItem> = {}): AnniversaryCatalogueItem => ({
  itemCode: "APX-1",
  drugId: 7,
  drugName: "Apixaban",
  activeIngredient: "Apixaban",
  brandName: "Eliquis",
  form: "Tablet 5 mg",
  liForm: "Tablet 5 mg",
  formulary: "F1",
  ...overrides,
});

const prediction = (overrides: Partial<AnniversaryPrediction> = {}): AnniversaryPrediction => ({
  id: 20,
  itemCode: "APX-1",
  drugId: 7,
  drugName: "Apixaban",
  brandName: "Eliquis",
  formulary: "F1",
  predictedDate: "2027-04-01",
  reductionType: "15-year statutory reduction",
  predictedPercentage: 5,
  predictedNewPrice: 95,
  currentPrice: 100,
  ...overrides,
});

test("normalised drug, form, and brand values resolve to the complete candidate code set", () => {
  const resolution = resolveAnniversaryRow(
    row({
      sourceDrugName: "Apixaban",
      sourceMoa: "Tablet, 5 mg",
      rawRow: { ...row().rawRow, "Brand Name": "ELIQUIS" },
    }),
    [
      item({ itemCode: "APX-1" }),
      item({ itemCode: "APX-2" }),
      item({ itemCode: "OTHER", brandName: "Other brand" }),
    ],
  );
  assert.deepEqual(resolution.candidateItemCodes, ["APX-1", "APX-2"]);
  assert.equal(resolution.matchedDrugId, 7);
});

test("published cent-rounded AEMPs calculate an implied percentage", () => {
  assert.equal(impliedReductionPercentage(100, 95), 5);
  assert.ok(Math.abs(impliedReductionPercentage(123.45, 117.28)! - 4.998) < 0.001);
});

test("candidate-set membership produces VERIFIED at the exact tolerance boundary", () => {
  const result = buildAnniversaryVerification({
    publishedRows: [row()],
    catalogueItems: [item({ itemCode: "APX-1" }), item({ itemCode: "APX-2" })],
    predictions: [prediction({ itemCode: "APX-2", predictedPercentage: 5 - ANNIVERSARY_PERCENTAGE_TOLERANCE })],
  });
  assert.equal(result.predictions[0]?.state, "VERIFIED");
  assert.deepEqual(result.predictions[0]?.evidence?.candidateItemCodes, ["APX-1", "APX-2"]);
  assert.equal(result.publishedRows[0]?.state, "VERIFIED");
});

test("a percentage beyond the tolerance is a GENUINE_MISMATCH", () => {
  const result = buildAnniversaryVerification({
    publishedRows: [row()],
    catalogueItems: [item()],
    predictions: [prediction({ predictedPercentage: 5 - ANNIVERSARY_PERCENTAGE_TOLERANCE - 0.001 })],
  });
  assert.equal(result.predictions[0]?.state, "GENUINE_MISMATCH");
  assert.equal(result.publishedRows[0]?.state, "GENUINE_MISMATCH");
});

test("an F2 catalogue item in an F1 anniversary workbook is a formulary discrepancy", () => {
  const result = buildAnniversaryVerification({
    publishedRows: [row()],
    catalogueItems: [item({ formulary: "F2" })],
    predictions: [prediction({ formulary: "F2" })],
  });
  assert.equal(result.predictions[0]?.state, "CATALOGUE_FORMULARY_DISCREPANCY");
  assert.equal(result.publishedRows[0]?.state, "CATALOGUE_FORMULARY_DISCREPANCY");
});

test("predictions and published rows without counterparts receive their own states", () => {
  const predictionOnly = buildAnniversaryVerification({
    publishedRows: [],
    catalogueItems: [item()],
    predictions: [prediction()],
  });
  assert.equal(predictionOnly.predictions[0]?.state, "PREDICTION_ONLY");

  const publishedOnly = buildAnniversaryVerification({
    publishedRows: [row()],
    catalogueItems: [item()],
    predictions: [],
  });
  assert.equal(publishedOnly.publishedRows[0]?.state, "PUBLISHED_ONLY");
});