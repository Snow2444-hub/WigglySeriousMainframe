import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { createReferenceRouter } from "../src/routes/reference";
import { createStockRouter } from "../src/routes/stock";
import { configuredIngestionStaleMinutes } from "../src/lib/ingestion-run-control";

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  process.env.AUTHORITY_BASELINE_OUTPUT ?? "../../docs/authority-baseline.json",
);
const BASELINE_USER_ID = "authority-baseline-reader";
const REPRESENTATIVE_DRUG_ID = 1_000_000;

if (
  process.env.NODE_ENV === "test" ||
  process.env.TEST_DATABASE_URL ||
  process.env.TEST_RUN_SCHEMA ||
  process.env.TEST_DATABASE_ISOLATED === "1" ||
  process.env.ALLOW_TEST_DATABASE === "1"
) {
  throw new Error("Authority baseline capture refuses test database markers.");
}

type QueryRow = Record<string, unknown>;

function stableIdHash(ids: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

async function query<T extends QueryRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}

async function inventory(
  tableName: string,
  stableIdColumn: string,
  authorityColumn: string,
) {
  const [counts] = await query<{
    row_count: number;
    null_authority_count: number;
    non_null_authority_count: number;
  }>(
    `SELECT
       count(*)::int AS row_count,
       count(*) FILTER (WHERE ${authorityColumn} IS NULL)::int AS null_authority_count,
       count(*) FILTER (WHERE ${authorityColumn} IS NOT NULL)::int AS non_null_authority_count
     FROM public.${tableName}`,
  );
  const stableIds = (
    await query<{ stable_id: string | number }>(
      `SELECT ${stableIdColumn} AS stable_id
       FROM public.${tableName}
       ORDER BY ${stableIdColumn}`,
    )
  ).map((row) => row.stable_id);
  return {
    stableIdColumn,
    rowCount: counts.row_count,
    nullAuthorityCount: counts.null_authority_count,
    nonNullAuthorityCount: counts.non_null_authority_count,
    stableIdsSha256: stableIdHash(stableIds),
    stableIds,
  };
}

function baselineAuth(req: Request, _res: Response, next: NextFunction) {
  req.userId = BASELINE_USER_ID;
  req.userRole = "user";
  next();
}

async function captureEndpoint(baseUrl: string, route: string) {
  const response = await fetch(`${baseUrl}${route}`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Baseline endpoint ${route} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return { route, status: response.status, body };
}

const [session] = await query<{
  current_database: string;
  current_schema: string;
  current_user: string;
  session_user: string;
}>(
  "SELECT current_database(), current_schema(), current_user, session_user",
);
if (session.current_schema !== "public") {
  throw new Error(`Authority baseline requires the public schema, received ${session.current_schema}.`);
}
if (session.current_user !== "pbs_app") {
  throw new Error(`Authority baseline requires current_user pbs_app, received ${session.current_user}.`);
}

const [
  drugs,
  pbsItems,
  predictedReductions,
  scheduleChanges,
  ingestionRuns,
] = await Promise.all([
  inventory("drugs", "id", "authority_scope"),
  inventory("pbs_items", "item_code", "authority_scope"),
  inventory("predicted_reductions", "id", "authority_run_id"),
  inventory("schedule_changes", "id", "authority_run_id"),
  inventory("ingestion_runs", "id", "authority_scope"),
]);

const [representativeItem] = await query<{
  item_code: string;
  pbs_code: string | null;
}>(
  `SELECT pr.item_code, pi.pbs_code
   FROM public.predicted_reductions pr
   JOIN public.pbs_items pi ON pi.item_code = pr.item_code
   WHERE pr.drug_id = $1
   ORDER BY pr.item_code
   LIMIT 1`,
  [REPRESENTATIVE_DRUG_ID],
);
if (!representativeItem) {
  throw new Error(`No representative predicted item exists for drug ${REPRESENTATIVE_DRUG_ID}.`);
}

const staleMinutes = configuredIngestionStaleMinutes();
const [
  latestRuns,
  activeRuns,
  currentScheduleRuns,
  predictionDistribution,
  scheduleChangeDistribution,
] = await Promise.all([
  query(
    `SELECT id, status, mode, schedule_date, schedule_code, schedule_effective_date,
            started_at, last_progress_at, finished_at, pages_fetched, total_schedules,
            schedules_processed, max_pages, snapshot_complete,
            change_detection_started_at, authority_scope
     FROM public.ingestion_runs
     ORDER BY id DESC
     LIMIT 10`,
  ),
  query(
    `SELECT id, status, mode, started_at, last_progress_at, cancel_requested_at,
            (coalesce(last_progress_at, started_at) <
              now() - ($1::int * interval '1 minute')) AS stale_at_capture
     FROM public.ingestion_runs
     WHERE status IN ('queued', 'running')
     ORDER BY started_at DESC`,
    [staleMinutes],
  ),
  query(
    `SELECT id, status, mode, schedule_code, schedule_effective_date, finished_at,
            snapshot_complete, authority_scope
     FROM public.ingestion_runs
     WHERE status = 'completed'
       AND snapshot_complete = true
       AND schedule_code IS NOT NULL
       AND schedule_effective_date IS NOT NULL
     ORDER BY finished_at DESC
     LIMIT 1`,
  ),
  query(
    `SELECT reduction_type, confidence, count(*)::int AS row_count,
            min(predicted_date) AS earliest_date, max(predicted_date) AS latest_date
     FROM public.predicted_reductions
     GROUP BY reduction_type, confidence
     ORDER BY reduction_type, confidence`,
  ),
  query(
    `SELECT change_type, significance, count(*)::int AS row_count,
            min(effective_date) AS earliest_date, max(effective_date) AS latest_date
     FROM public.schedule_changes
     GROUP BY change_type, significance
     ORDER BY change_type, significance`,
  ),
]);

const app = express();
app.use(express.json());
app.use("/api", createReferenceRouter(undefined, baselineAuth));
app.use("/api", createStockRouter(undefined, baselineAuth));
const server = createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Baseline route server did not bind.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const encodedItemCode = encodeURIComponent(representativeItem.item_code);
  const endpointResponses = await Promise.all([
    captureEndpoint(baseUrl, `/api/drugs/${REPRESENTATIVE_DRUG_ID}`),
    captureEndpoint(baseUrl, `/api/pbs-items/${encodedItemCode}`),
    captureEndpoint(baseUrl, `/api/pbs-items/${encodedItemCode}/predicted-reductions`),
    captureEndpoint(baseUrl, `/api/pbs-items/${encodedItemCode}/schedule-changes`),
    captureEndpoint(baseUrl, `/api/schedule-changes?drugId=${REPRESENTATIVE_DRUG_ID}&limit=200`),
    captureEndpoint(baseUrl, `/api/drugs/${REPRESENTATIVE_DRUG_ID}/schedule-timeline`),
    captureEndpoint(baseUrl, "/api/dashboard"),
  ]);

  const baseline = {
    version: 1,
    capturedAt: new Date().toISOString(),
    source: {
      environment: "development",
      schema: session.current_schema,
      database: session.current_database,
      currentUser: session.current_user,
      sessionUser: session.session_user,
      isolationMarkersRejected: true,
    },
    representativeRecords: {
      drugId: REPRESENTATIVE_DRUG_ID,
      itemCode: representativeItem.item_code,
      pbsCode: representativeItem.pbs_code,
    },
    inventory: {
      drugs,
      pbsItems,
      predictedReductions,
      scheduleChanges,
      ingestionRuns,
    },
    ingestionState: {
      staleThresholdMinutes: staleMinutes,
      latestRuns,
      activeRuns,
      activeRunCount: activeRuns.length,
      dashboardCurrentScheduleRun: currentScheduleRuns[0] ?? null,
    },
    derivedResults: {
      predictionDistribution,
      scheduleChangeDistribution,
    },
    endpointResponses,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(`Authority baseline written to ${OUTPUT_PATH}`);
  console.log(
    JSON.stringify({
      representativeRecords: baseline.representativeRecords,
      rowCounts: Object.fromEntries(
        Object.entries(baseline.inventory).map(([name, value]) => [
          name,
          { rows: value.rowCount, nullAuthority: value.nullAuthorityCount },
        ]),
      ),
      activeRunCount: baseline.ingestionState.activeRunCount,
      currentScheduleRunId: baseline.ingestionState.dashboardCurrentScheduleRun?.id ?? null,
    }, null, 2),
  );
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
}