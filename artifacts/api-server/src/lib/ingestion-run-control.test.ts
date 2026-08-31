import assert from "node:assert/strict";
import test from "node:test";
import { db, ingestionRunsTable, rawScheduleStagingTable, runtimeAuthorityScope } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { pruneRawScheduleStaging } from "./ingestion-run-control";

test("prunes invalid future snapshots without sacrificing the newest valid real snapshot", async () => {
  const token = (Date.now() + process.pid) % 100_000_000;
  const validScheduleCode = 1_600_000_000 + token;
  const futureScheduleCode = validScheduleCode + 1;
  const scheduleDate = `${4090 + (token % 100)}-09-01`;
  const now = new Date("2026-08-30T12:00:00.000Z");
  const oldFetchedAt = new Date("2026-08-27T12:00:00.000Z");
  let runId: number | undefined;

  try {
    const [run] = await db
      .insert(ingestionRunsTable)
      .values({
        status: "completed",
        mode: "current",
        scheduleDate: "2026-08-30",
        authorityScope: runtimeAuthorityScope(),
      })
      .returning({ id: ingestionRunsTable.id });
    assert.ok(run);
    runId = run.id;

    await db.insert(rawScheduleStagingTable).values([
      {
        scheduleDate,
        endpoint: "schedules",
        requestKey: `schedule-metadata:${validScheduleCode}`,
        pageNumber: 1,
        payload: { data: [{ schedule_code: validScheduleCode, effective_date: "2026-08-01" }] },
        fetchedAt: oldFetchedAt,
      },
      {
        scheduleDate,
        endpoint: "schedules",
        requestKey: `schedule-metadata:${futureScheduleCode}`,
        pageNumber: 1,
        payload: { data: [{ schedule_code: futureScheduleCode, effective_date: "2092-01-01" }] },
        fetchedAt: oldFetchedAt,
      },
      {
        scheduleDate,
        endpoint: "items",
        requestKey: `items-snapshot:schedule-${validScheduleCode}:run-${runId}`,
        pageNumber: 1,
        coverageScope: "schedule",
        coverageComplete: true,
        payload: { data: [] },
        fetchedAt: oldFetchedAt,
      },
      {
        scheduleDate,
        endpoint: "items",
        requestKey: `items-snapshot:schedule-${futureScheduleCode}:run-${runId}`,
        pageNumber: 1,
        coverageScope: "schedule",
        coverageComplete: true,
        payload: { data: [] },
        fetchedAt: oldFetchedAt,
      },
    ]);

    assert.deepEqual(
      await pruneRawScheduleStaging({
        retentionHours: 48,
        now,
        scheduleCodes: [validScheduleCode, futureScheduleCode],
      }),
      { deletedRows: 1 },
    );

    const remaining = await db
      .select({ requestKey: rawScheduleStagingTable.requestKey })
      .from(rawScheduleStagingTable)
      .where(eq(rawScheduleStagingTable.scheduleDate, scheduleDate));
    const itemRequestKeys = remaining
      .map((row) => row.requestKey)
      .filter((requestKey) => requestKey.startsWith("items-snapshot:"));
    assert.deepEqual(itemRequestKeys, [
      `items-snapshot:schedule-${validScheduleCode}:run-${runId}`,
    ]);
  } finally {
    await db.delete(rawScheduleStagingTable).where(
      and(
        eq(rawScheduleStagingTable.scheduleDate, scheduleDate),
        inArray(rawScheduleStagingTable.requestKey, [
          `schedule-metadata:${validScheduleCode}`,
          `schedule-metadata:${futureScheduleCode}`,
          `items-snapshot:schedule-${validScheduleCode}:run-${runId}`,
          `items-snapshot:schedule-${futureScheduleCode}:run-${runId}`,
        ]),
      ),
    );
    if (runId !== undefined) {
      await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, runId));
    }
  }
});