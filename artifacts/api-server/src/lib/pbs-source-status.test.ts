import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluatePbsSourceStatus,
  PBS_SOURCE_DEFINITIONS,
  type PublishedSourceKey,
} from "./pbs-source-status";
import type { PbsPublishedFile } from "@workspace/db";

function file(overrides: Partial<PbsPublishedFile> = {}): PbsPublishedFile {
  return {
    id: 1,
    sourceKey: "anniversary_indicative",
    pageUrl: "https://www.pbs.gov.au/industry/pricing",
    fileUrl: "https://www.pbs.gov.au/industry/pricing/annual.xlsx",
    fileName: "annual.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileSha256: "hash-1",
    rawContentBase64: "encoded",
    retrievedAt: new Date("2026-01-02T03:04:05.000Z"),
    parsedAt: new Date("2026-01-02T03:05:05.000Z"),
    fetchStatus: "succeeded",
    parseStatus: "succeeded",
    failureStage: null,
    ingestionRunId: null,
    reportPublicationDate: "2026-01-01",
    effectiveDate: null,
    parserVersion: "test",
    status: "completed",
    parseHealth: "healthy",
    totalRows: 4,
    matchedRows: 3,
    rejectedRows: 1,
    watchlistUnmatchedRows: 0,
    errorMessage: null,
    metadata: null,
    isCurrent: true,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    ...overrides,
  };
}

function definition(sourceKey: PublishedSourceKey) {
  const found = PBS_SOURCE_DEFINITIONS.find((entry) => entry.sourceKey === sourceKey);
  assert.ok(found);
  return found;
}

test("annual sources become stale after the 1 August refresh window", () => {
  const row = evaluatePbsSourceStatus(
    definition("anniversary_indicative"),
    [file()],
    "2026-08-14",
  );
  assert.equal(row.status, "OK");
  assert.equal(row.nextExpectedRefreshDate, "2026-08-01");
  assert.equal(row.staleAfterDate, "2026-08-15");

  const stale = evaluatePbsSourceStatus(
    definition("anniversary_indicative"),
    [file()],
    "2026-08-16",
  );
  assert.equal(stale.status, "STALE");
});

test("price-disclosure sources use the next April or October cycle", () => {
  const row = evaluatePbsSourceStatus(
    definition("confirmed_non_efc"),
    [file({ sourceKey: "confirmed_non_efc", reportPublicationDate: "2026-04-01" })],
    "2026-09-01",
  );
  assert.equal(row.nextExpectedRefreshDate, "2026-10-01");
  assert.equal(row.staleAfterDate, "2026-10-15");
  assert.equal(row.status, "OK");
});

test("the latest failed attempt takes precedence over older successful evidence", () => {
  const row = evaluatePbsSourceStatus(
    definition("anniversary_indicative"),
    [
      file({ id: 1 }),
      file({
        id: 2,
        status: "failed",
        parseHealth: "rejected",
        parseStatus: "failed",
        failureStage: "parse",
        errorMessage: "Required header missing",
        retrievedAt: new Date("2026-08-03T03:04:05.000Z"),
        parsedAt: null,
        fileSha256: "hash-2",
      }),
    ],
    "2026-08-04",
  );
  assert.equal(row.status, "FAILED");
  assert.equal(row.lastSuccessfulFileSha256, "hash-1");
  assert.equal(row.latestFileSha256, "hash-2");
  assert.equal(row.latestFailureStage, "parse");
  assert.equal(row.latestFailureMessage, "Required header missing");
});

test("a successful recovery becomes healthy again", () => {
  const row = evaluatePbsSourceStatus(
    definition("anniversary_indicative"),
    [
      file({ id: 1 }),
      file({
        id: 2,
        status: "failed",
        parseHealth: "rejected",
        parseStatus: "failed",
        failureStage: "fetch",
        errorMessage: "PBS page returned 503",
        parsedAt: null,
      }),
      file({
        id: 3,
        reportPublicationDate: "2026-08-03",
        retrievedAt: new Date("2026-08-04T03:04:05.000Z"),
        parsedAt: new Date("2026-08-04T03:05:05.000Z"),
        fileSha256: "hash-3",
      }),
    ],
    "2026-08-05",
  );
  assert.equal(row.status, "OK");
  assert.equal(row.latestFailureMessage, null);
  assert.equal(row.lastSuccessfulFileSha256, "hash-3");
});

test("unconfigured FNB cadence is visible without inventing a stale date", () => {
  const row = evaluatePbsSourceStatus(
    definition("first_new_brand"),
    [file({ sourceKey: "first_new_brand" })],
    "2026-08-30",
  );
  assert.equal(row.status, "OK");
  assert.equal(row.cadenceLabel, "Cadence not configured");
  assert.equal(row.nextExpectedRefreshDate, null);
  assert.equal(row.staleAfterDate, null);
});

test("missing publication dates remain visible and use retrieval time only for cadence", () => {
  const row = evaluatePbsSourceStatus(
    definition("anniversary_indicative"),
    [file({ reportPublicationDate: null, effectiveDate: null, retrievedAt: new Date("2026-08-02T03:04:05.000Z") })],
    "2026-08-30",
  );
  assert.equal(row.status, "OK");
  assert.equal(row.publicationDate, null);
  assert.equal(row.nextExpectedRefreshDate, "2027-08-01");
});

test("duplicate successful observations do not create a second health state", () => {
  const row = evaluatePbsSourceStatus(
    definition("anniversary_indicative"),
    [file({ id: 1 }), file({ id: 2, fileSha256: "hash-1", retrievedAt: new Date("2026-01-03T03:04:05.000Z") })],
    "2026-01-04",
  );
  assert.equal(row.status, "OK");
  assert.equal(row.latestFileSha256, "hash-1");
  assert.equal(row.lastSuccessfulFileSha256, "hash-1");
});

test("a fetch failure is reported separately from a parse failure", () => {
  const row = evaluatePbsSourceStatus(
    definition("subject_to_price_disclosure"),
    [file({
      sourceKey: "subject_to_price_disclosure",
      status: "failed",
      parseHealth: "rejected",
      fetchStatus: "failed",
      parseStatus: "not_attempted",
      failureStage: "fetch",
      rawContentBase64: "",
      parsedAt: null,
      errorMessage: "PBS page returned 503",
    })],
    "2026-08-30",
  );
  assert.equal(row.status, "FAILED");
  assert.equal(row.latestFailureStage, "fetch");
  assert.equal(row.latestFailureMessage, "PBS page returned 503");
});

test("a source with no observation is visibly failed", () => {
  const row = evaluatePbsSourceStatus(
    definition("combination_flow_on"),
    [],
    "2026-08-30",
  );
  assert.equal(row.status, "FAILED");
  assert.equal(row.latestAttemptStatus, null);
  assert.match(row.latestFailureMessage ?? "", /No successful observation/);
});