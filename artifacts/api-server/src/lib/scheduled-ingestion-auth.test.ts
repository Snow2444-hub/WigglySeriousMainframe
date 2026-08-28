import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduledIngestionTokenMatches } from "./scheduled-ingestion-auth";

test("scheduled ingestion token matching accepts the exact configured token", () => {
  assert.equal(scheduledIngestionTokenMatches("cron-secret", "cron-secret"), true);
  assert.equal(scheduledIngestionTokenMatches("cron-secret", "wrong-secret"), false);
  assert.equal(scheduledIngestionTokenMatches("cron-secret", undefined), false);
  assert.equal(scheduledIngestionTokenMatches(undefined, "cron-secret"), false);
  assert.equal(scheduledIngestionTokenMatches("", "cron-secret"), false);
});