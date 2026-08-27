import { db, ingestionRunsTable } from "@workspace/db";
import { executeIngestionRun } from "../src/routes/admin.ts";

const [run] = await db.insert(ingestionRunsTable).values({ status: "queued" }).returning();
if (!run) throw new Error("Unable to create backfill run");
console.log(JSON.stringify({ event: "backfill_started", runId: run.id }));
await executeIngestionRun(run.id, new Date().toISOString().slice(0, 10), undefined, "backfill");
const [completed] = await db.select().from(ingestionRunsTable).where((table, { eq }) => eq(table.id, run.id));
console.log(JSON.stringify({ event: "backfill_finished", run: completed }));
