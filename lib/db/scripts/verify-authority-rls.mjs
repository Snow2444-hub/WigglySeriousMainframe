import { spawn } from "node:child_process";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to verify the authority RLS boundary.");
}

function applicationRoleDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const existingOptions = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existingOptions, "-c role=pbs_app"].filter(Boolean).join(" "),
  );
  url.search = `?${url.searchParams.toString().replaceAll("+", "%20")}`;
  return url.toString();
}

function runCapture(databaseUrl, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "psql",
      [
        databaseUrl,
        "--tuples-only",
        "--no-align",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        sql,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code: signal ? 1 : code ?? 1, stdout, stderr });
    });
  });
}

const probeId = -2_000_000_000 + (process.pid % 1_000_000);
const probeItemCode = `RLS-PROBE-${Math.abs(probeId)}`;
const appUrl = applicationRoleDatabaseUrl(process.env.DATABASE_URL);
let inserted = false;

try {
  const insert = await runCapture(
    process.env.DATABASE_URL,
    `BEGIN;
    INSERT INTO public.ingestion_runs (
      id, status, authority_scope
    ) VALUES (
      ${probeId}, 'completed', 'test:rls-verification'
    );
    INSERT INTO public.drugs (
      id, name, active_ingredient, sponsor, first_pbs_listing_date, authority_scope
    ) VALUES (
      ${probeId}, 'RLS verification probe', 'RLS verification probe',
      'RLS verification probe', DATE '2000-01-01', 'test:rls-verification'
    );
    INSERT INTO public.pbs_items (
      item_code, drug_id, brand_name, formulary, current_aemp, last_updated, authority_scope
    ) VALUES (
      '${probeItemCode}', ${probeId}, 'RLS verification probe', 'F2', 1, DATE '2000-01-01',
      'test:rls-verification'
    );
    INSERT INTO public.predicted_reductions (
      item_code, drug_id, predicted_date, reduction_type, predicted_percentage,
      predicted_new_price, confidence, source_note, authority_run_id
    ) VALUES (
      '${probeItemCode}', ${probeId}, DATE '2099-01-01', 'rls_verification', 99,
      0.01, 'verified', 'RLS verification probe', ${probeId}
    );
    INSERT INTO public.schedule_changes (
      schedule_code, effective_date, change_type, drug_id, notes, authority_run_id
    ) VALUES (
      ${probeId}, DATE '2099-01-01', 'rls_verification', ${probeId},
      'RLS verification probe', ${probeId}
    );
    COMMIT;`,
  );
  if (insert.code !== 0) throw new Error(`Could not create RLS verification rows: ${insert.stderr.trim()}`);
  inserted = true;

  const proof = await runCapture(
    appUrl,
    `SELECT
      current_user || '|' ||
      session_user || '|' ||
      (SELECT count(*) FROM public.ingestion_runs WHERE id = ${probeId}) || '|' ||
      (SELECT count(*) FROM public.drugs WHERE id = ${probeId}) || '|' ||
      (SELECT count(*) FROM public.pbs_items WHERE item_code = '${probeItemCode}') || '|' ||
      (SELECT count(*) FROM public.predicted_reductions WHERE authority_run_id = ${probeId}) || '|' ||
      (SELECT count(*) FROM public.schedule_changes WHERE authority_run_id = ${probeId}) || '|' ||
      (
        SELECT bool_and(
          pg_get_userbyid(relowner) = 'pbs_app'
          AND relrowsecurity
          AND relforcerowsecurity
        )
        FROM pg_class
        WHERE oid = ANY(ARRAY[
          'public.ingestion_runs'::regclass,
          'public.drugs'::regclass,
          'public.pbs_items'::regclass,
          'public.predicted_reductions'::regclass,
          'public.schedule_changes'::regclass
        ])
      )`,
  );
  if (proof.code !== 0) throw new Error(`RLS verification query failed: ${proof.stderr.trim()}`);
  const result = proof.stdout.trim();
  if (result !== "pbs_app|postgres|0|0|0|0|0|true") {
    throw new Error(`RLS verification failed with result: ${result}`);
  }
  console.log(
    "RLS verified: pbs_app owns all forced-RLS tables and raw SQL cannot see test-scoped master, root, or derived rows.",
  );
} finally {
  if (inserted) {
    const cleanup = await runCapture(
      process.env.DATABASE_URL,
      `BEGIN;
      DELETE FROM public.predicted_reductions WHERE authority_run_id = ${probeId};
      DELETE FROM public.schedule_changes WHERE authority_run_id = ${probeId};
      DELETE FROM public.pbs_items WHERE item_code = '${probeItemCode}';
      DELETE FROM public.drugs WHERE id = ${probeId};
      DELETE FROM public.ingestion_runs WHERE id = ${probeId};
      COMMIT;`,
    );
    if (cleanup.code !== 0) {
      throw new Error(`Could not remove RLS verification rows: ${cleanup.stderr.trim()}`);
    }
  }
}