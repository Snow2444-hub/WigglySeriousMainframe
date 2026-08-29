import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { db, rawScheduleStagingTable } from "@workspace/db";
import { fetchSchedule } from "./pbs-ingestion";

test("resumes from a staged page without fetching it again", async () => {
  const runId = 1_980_000_000 + ((Date.now() + process.pid) % 100_000);
  const scheduleDate = "2093-01-01";
  const requestKey = `resume-items:run-${runId}`;
  let requested = false;
  const payload = {
    data: [
      {
        li_item_id: "resume-item-1",
        schedule_code: 20930101,
        effective_date: "2093-01-01",
        active_ingredient: "Resume fixture ingredient",
      },
    ],
  };

  try {
    await db.insert(rawScheduleStagingTable).values({
      scheduleDate,
      endpoint: "items",
      requestKey,
      pageNumber: 1,
      coverageScope: "schedule",
      payload,
    });

    const pages = await fetchSchedule({
      scheduleDate,
      endpoints: ["items"],
      limit: 100,
      filters: [{ requestKey: "resume-items", params: {} }],
      coverageScope: "schedule",
      stagingRunId: runId,
      resumeFromStaging: true,
      request: async () => {
        requested = true;
        throw new Error("the staged page should have been replayed");
      },
      sleep: async () => {},
    });

    assert.equal(requested, false);
    assert.deepEqual(pages, [
      {
        endpoint: "items",
        requestKey,
        pageNumber: 1,
        records: 1,
        url: "https://data-api.health.gov.au/pbs/api/v3/items?get_latest_schedule_only=true&page=1&limit=100",
      },
    ]);

    const [stagedPage] = await db
      .select({ coverageComplete: rawScheduleStagingTable.coverageComplete })
      .from(rawScheduleStagingTable)
      .where(
        and(
          eq(rawScheduleStagingTable.scheduleDate, scheduleDate),
          eq(rawScheduleStagingTable.requestKey, requestKey),
        ),
      );
    assert.deepEqual(stagedPage, { coverageComplete: true });
  } finally {
    await db
      .delete(rawScheduleStagingTable)
      .where(
        and(
          eq(rawScheduleStagingTable.scheduleDate, scheduleDate),
          eq(rawScheduleStagingTable.requestKey, requestKey),
        ),
      );
  }
});