import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db, ingestionRunsTable, pool, runtimeAuthorityScope } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  acquireIngestionRun,
  recoverInterruptedIngestionRuns,
  recoverStaleIngestionRuns,
} from "./ingestion-run-control";
import { resumeIngestionRun, runScheduledIngestion, startScheduledIngestion } from "./scheduled-ingestion";

let fixtureNumber = 0;

function fixtureId(): number {
  fixtureNumber += 1;
  return 1_900_000_000 + (process.pid % 100_000) * 100 + fixtureNumber;
}

async function deleteRuns(runIds: number[]): Promise<void> {
  if (runIds.length > 0) {
    await db
      .delete(ingestionRunsTable)
      .where(and(inArray(ingestionRunsTable.id, runIds), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
  }
}

async function activeRunIds(): Promise<number[]> {
  const runs = await db
    .select({ id: ingestionRunsTable.id })
    .from(ingestionRunsTable)
    .where(and(inArray(ingestionRunsTable.status, ["queued", "running"]), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
  return runs.map((run) => run.id);
}

test("scheduled ingestion creates and completes an auditable run", async () => {
  const now = new Date("2026-08-28T02:00:00.000Z");
  const excludeActiveRunIds = await activeRunIds();
  let runId: number | undefined;

  try {
    const result = await runScheduledIngestion({
      now,
      scheduleDate: "2026-08-28",
      excludeActiveRunIds,
      execute: async (createdRunId) => {
        runId = createdRunId;
        await db
          .update(ingestionRunsTable)
          .set({ status: "completed", finishedAt: now, recordsProcessed: 3 })
          .where(and(eq(ingestionRunsTable.id, createdRunId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.runId, runId);
    const [run] = await db
      .select({ status: ingestionRunsTable.status, recordsProcessed: ingestionRunsTable.recordsProcessed })
      .from(ingestionRunsTable)
      .where(and(eq(ingestionRunsTable.id, runId as number), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
    assert.deepEqual(run, { status: "completed", recordsProcessed: 3 });
  } finally {
    await deleteRuns(runId ? [runId] : []);
  }
});

test("scheduled ingestion skips an active manual or scheduled run", async () => {
  const excludeActiveRunIds = await activeRunIds();
  const acquired = await acquireIngestionRun({ excludeActiveRunIds });
  if (!("run" in acquired) || !acquired.run) throw new Error("Expected the fixture run to be created");
  const activeRunId = acquired.run.id;

  try {
    let executorCalled = false;
    const result = await runScheduledIngestion({
      now: new Date("2026-08-28T02:00:00.000Z"),
      excludeActiveRunIds,
      execute: async () => {
        executorCalled = true;
      },
    });

    assert.deepEqual(result, {
      status: "skipped",
      activeRunId,
      recoveredRunIds: [],
    });
    assert.equal(executorCalled, false);
  } finally {
    await deleteRuns([activeRunId]);
  }
});

test("background scheduled ingestion preserves the active-run guard", async () => {
  const excludeActiveRunIds = await activeRunIds();
  let releaseExecution!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  let signalExecutionStarted!: () => void;
  const executionStartedSignal = new Promise<void>((resolve) => {
    signalExecutionStarted = resolve;
  });
  let executionFinished!: () => void;
  const executionFinishedSignal = new Promise<void>((resolve) => {
    executionFinished = resolve;
  });
  let firstRunId: number | undefined;
  let secondExecutorCalled = false;

  try {
    const firstResult = await startScheduledIngestion({
      now: new Date("2026-08-28T02:00:00.000Z"),
      scheduleDate: "2026-08-28",
      excludeActiveRunIds,
      execute: async (runId) => {
        firstRunId = runId;
        signalExecutionStarted();
        await executionStarted;
        await db
          .update(ingestionRunsTable)
          .set({ status: "completed", finishedAt: new Date(), recordsProcessed: 1 })
          .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
        executionFinished();
      },
    });

    assert.equal(firstResult.status, "accepted");
    if (firstResult.status !== "accepted") throw new Error("Expected the first run to be accepted");

    const secondResult = await startScheduledIngestion({
      now: new Date("2026-08-28T02:00:01.000Z"),
      excludeActiveRunIds,
      execute: async () => {
        secondExecutorCalled = true;
      },
    });
    assert.deepEqual(secondResult, {
      status: "skipped",
      activeRunId: firstResult.runId,
      recoveredRunIds: [],
    });
    assert.equal(secondExecutorCalled, false);

    await executionStartedSignal;
    releaseExecution();
    await executionFinishedSignal;

    const [run] = await db
      .select({ status: ingestionRunsTable.status })
      .from(ingestionRunsTable)
      .where(and(eq(ingestionRunsTable.id, firstResult.runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
    assert.deepEqual(run, { status: "completed" });
  } finally {
    if (firstRunId) await deleteRuns([firstRunId]);
  }
});

test("scheduled ingestion recovers stale work and marks uncaught failures", async () => {
  const staleRunId = fixtureId();
  const now = new Date("2026-08-28T02:00:00.000Z");
  const excludeActiveRunIds = await activeRunIds();
  const staleStartedAt = new Date("2026-08-27T20:00:00.000Z");
  await db.insert(ingestionRunsTable).values({
    id: staleRunId,
    startedAt: now,
    lastProgressAt: staleStartedAt,
    status: "running",
    authorityScope: runtimeAuthorityScope(),
  });
  let failedRunId: number | undefined;

  try {
    const result = await runScheduledIngestion({
      now,
      staleRunMinutes: 180,
      excludeActiveRunIds,
      execute: async (runId) => {
        failedRunId = runId;
        throw new Error("simulated scheduled failure");
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.runId, failedRunId);
    assert.match(result.errorMessage, /simulated scheduled failure/);
    if (!failedRunId) throw new Error("Expected the scheduled failure run to be created");

    const runs = await db
      .select({
        id: ingestionRunsTable.id,
        status: ingestionRunsTable.status,
        errorMessage: ingestionRunsTable.errorMessage,
      })
      .from(ingestionRunsTable)
      .where(and(inArray(ingestionRunsTable.id, [staleRunId, failedRunId]), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
    assert.deepEqual(
      runs.sort((left, right) => left.id - right.id),
      [
        {
          id: staleRunId,
          status: "failed",
          errorMessage: "Ingestion was recovered as stale before a scheduled run",
        },
        {
          id: failedRunId,
          status: "failed",
          errorMessage: "simulated scheduled failure",
        },
      ].sort((left, right) => left.id - right.id),
    );
  } finally {
    await deleteRuns([staleRunId, ...(failedRunId ? [failedRunId] : [])]);
  }
});

test("stalled ingestion runs are retired using last page progress, not start time", async () => {
  const staleRunId = fixtureId();
  const activeRunId = fixtureId();
  const now = new Date("2026-08-28T02:00:00.000Z");
  const staleProgressAt = new Date("2026-08-27T20:00:00.000Z");
  const recentProgressAt = new Date("2026-08-28T01:59:00.000Z");

  try {
    await db.insert(ingestionRunsTable).values([
      {
        id: staleRunId,
        startedAt: now,
        lastProgressAt: staleProgressAt,
        status: "running",
        authorityScope: runtimeAuthorityScope(),
      },
      {
        id: activeRunId,
        startedAt: now,
        lastProgressAt: recentProgressAt,
        status: "running",
        authorityScope: runtimeAuthorityScope(),
      },
    ]);

    const recovered = await recoverStaleIngestionRuns(new Date("2026-08-28T01:00:00.000Z"));
    assert.deepEqual(recovered.map((run) => run.id), [staleRunId]);

    const runs = await db
      .select({
        id: ingestionRunsTable.id,
        status: ingestionRunsTable.status,
        errorMessage: ingestionRunsTable.errorMessage,
      })
      .from(ingestionRunsTable)
      .where(and(inArray(ingestionRunsTable.id, [staleRunId, activeRunId]), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
    assert.deepEqual(
      runs.sort((left, right) => left.id - right.id),
      [
        { id: staleRunId, status: "failed", errorMessage: "Ingestion marked stale after no page progress" },
        { id: activeRunId, status: "running", errorMessage: null },
      ].sort((left, right) => left.id - right.id),
    );
  } finally {
    await deleteRuns([staleRunId, activeRunId]);
  }
});

test("API restart requeues and resumes an interrupted run with its original configuration", async () => {
  const runId = fixtureId();
  const scheduleDate = "2026-08-28";
  let resumed: { runId: number; scheduleDate: string; maxPages: number | undefined; mode: string | undefined } | undefined;

  try {
    await db.insert(ingestionRunsTable).values({
      id: runId,
      status: "running",
      mode: "backfill",
      scheduleDate,
      maxPages: 17,
      recordsProcessed: 42,
      pagesFetched: 5,
        authorityScope: runtimeAuthorityScope(),
    });

    const recoveredRuns = await recoverInterruptedIngestionRuns([runId]);
    const recoveredRun = recoveredRuns.find((candidate) => candidate.id === runId);
    assert.ok(recoveredRun);
    assert.equal(recoveredRun.status, "queued");
    assert.equal(recoveredRun.scheduleDate, scheduleDate);
    assert.equal(recoveredRun.maxPages, 17);

    await resumeIngestionRun(recoveredRun, async (recoveredRunId, recoveredScheduleDate, maxPages, mode) => {
      resumed = { runId: recoveredRunId, scheduleDate: recoveredScheduleDate, maxPages, mode };
      await db
        .update(ingestionRunsTable)
        .set({ status: "completed", finishedAt: new Date(), scheduleDate: recoveredScheduleDate })
        .where(and(eq(ingestionRunsTable.id, recoveredRunId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
    });

    assert.deepEqual(resumed, { runId, scheduleDate, maxPages: 17, mode: "backfill" });
    const [run] = await db
      .select({ status: ingestionRunsTable.status })
      .from(ingestionRunsTable)
      .where(and(eq(ingestionRunsTable.id, runId), eq(ingestionRunsTable.authorityScope, runtimeAuthorityScope())));
    assert.deepEqual(run, { status: "completed" });
  } finally {
    await deleteRuns([runId]);
  }
});

after(async () => {
  await pool.end();
});