import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublishedReportFresh, sourcePriority } from "./pbs-published-files";

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