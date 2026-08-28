import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db, ingestionRunsTable, pool } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { acquireIngestionRun } from "./ingestion-run-control";
import { runScheduledIngestion, startScheduledIngestion } from "./scheduled-ingestion";

let fixtureNumber = 0;

function fixtureId(): number {
  fixtureNumber += 1;
  return 1_900_000_000 + (process.pid % 100_000) * 100 + fixtureNumber;
}

async function deleteRuns(runIds: number[]): Promise<void> {
  if (runIds.length > 0) {
    await db.delete(ingestionRunsTable).where(inArray(ingestionRunsTable.id, runIds));
  }
}

test("scheduled ingestion creates and completes an auditable run", async () => {
  const now = new Date("2026-08-28T02:00:00.000Z");
  let runId: number | undefined;

  try {
    const result = await runScheduledIngestion({
      now,
      scheduleDate: "2026-08-28",
      execute: async (createdRunId) => {
        runId = createdRunId;
        await db
          .update(ingestionRunsTable)
          .set({ status: "completed", finishedAt: now, recordsProcessed: 3 })
          .where(eq(ingestionRunsTable.id, createdRunId));
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.runId, runId);
    const [run] = await db
      .select({ status: ingestionRunsTable.status, recordsProcessed: ingestionRunsTable.recordsProcessed })
      .from(ingestionRunsTable)
      .where(eq(ingestionRunsTable.id, runId as number));
    assert.deepEqual(run, { status: "completed", recordsProcessed: 3 });
  } finally {
    await deleteRuns(runId ? [runId] : []);
  }
});

test("scheduled ingestion skips an active manual or scheduled run", async () => {
  const acquired = await acquireIngestionRun();
  if (!("run" in acquired) || !acquired.run) throw new Error("Expected the fixture run to be created");
  const activeRunId = acquired.run.id;

  try {
    let executorCalled = false;
    const result = await runScheduledIngestion({
      now: new Date("2026-08-28T02:00:00.000Z"),
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
      execute: async (runId) => {
        firstRunId = runId;
        signalExecutionStarted();
        await executionStarted;
        await db
          .update(ingestionRunsTable)
          .set({ status: "completed", finishedAt: new Date(), recordsProcessed: 1 })
          .where(eq(ingestionRunsTable.id, runId));
        executionFinished();
      },
    });

    assert.equal(firstResult.status, "accepted");
    if (firstResult.status !== "accepted") throw new Error("Expected the first run to be accepted");

    const secondResult = await startScheduledIngestion({
      now: new Date("2026-08-28T02:00:01.000Z"),
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
      .where(eq(ingestionRunsTable.id, firstResult.runId));
    assert.deepEqual(run, { status: "completed" });
  } finally {
    if (firstRunId) await deleteRuns([firstRunId]);
  }
});

test("scheduled ingestion recovers stale work and marks uncaught failures", async () => {
  const staleRunId = fixtureId();
  const now = new Date("2026-08-28T02:00:00.000Z");
  const staleStartedAt = new Date("2026-08-27T20:00:00.000Z");
  await db.insert(ingestionRunsTable).values({
    id: staleRunId,
    startedAt: staleStartedAt,
    status: "running",
  });
  let failedRunId: number | undefined;

  try {
    const result = await runScheduledIngestion({
      now,
      staleRunMinutes: 180,
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
      .where(inArray(ingestionRunsTable.id, [staleRunId, failedRunId]));
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

after(async () => {
  await pool.end();
});