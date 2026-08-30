import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import express from "express";
import { db, pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { createReferenceRouter } from "./reference";
import { createStockRouter } from "./stock";

const token = `authority_matrix_${process.pid}_${Date.now()}`;
const scope = `test:${process.env.TEST_ISOLATION_SCHEMA ?? ""}`;
const drugId = 1_700_000_000 + (process.pid % 100_000);
const scheduleCode = 700_000_000 + (process.pid % 100_000);
const itemCode = `${token}_item`;
const searchTerm = `${token}_search`;
const userId = `${token}_user`;
let baseUrl = "";
let server: Server;

const testAuth = ((req, _res, next) => {
  const authenticatedUser = req.header("x-test-user");
  if (!authenticatedUser) throw new Error("Test requests must include x-test-user");
  req.userId = authenticatedUser;
  next();
}) as typeof requireAuth;

function sqlLiteral(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function assertAdminEnvironment(): string {
  const databaseUrl = process.env.DATABASE_URL;
  const schema = process.env.TEST_ISOLATION_SCHEMA;
  const isolationDatabase = process.env.TEST_ISOLATION_DATABASE;
  if (process.env.NODE_ENV !== "test" || !databaseUrl || !schema || !isolationDatabase) {
    throw new Error("Authority matrix admin fixture requires the isolated NODE_ENV=test runner.");
  }
  const options = new URL(databaseUrl).searchParams.get("options") ?? "";
  if (
    !options.includes(`search_path=${schema}`)
    && !(schema === "public" && isolationDatabase === "dedicated")
  ) {
    throw new Error("Authority matrix admin fixture refused a DATABASE_URL without its isolation schema token.");
  }
  return databaseUrl;
}

/** Test-only privileged fixture channel.  It intentionally never SET ROLEs. */
async function adminSql(statement: string): Promise<string> {
  const databaseUrl = assertAdminEnvironment();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "psql",
      [databaseUrl, "--quiet", "--no-psqlrc", "--no-align", "--tuples-only", "--set", "ON_ERROR_STOP=1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Admin fixture SQL failed: ${stderr.trim()}`));
    });
    child.stdin.end(statement);
  });
}

async function assertAdminRow(table: string, where: string): Promise<void> {
  const count = await adminSql(`SELECT count(*) FROM ${table} WHERE ${where};`);
  assert.equal(count, "1", `Expected admin fixture row in ${table}`);
}

async function request(path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": userId } });
  assert.equal(response.status, 200);
  return response.json();
}

async function withFailureBeforeTeardown(
  insert: () => Promise<void>,
  exists: () => Promise<void>,
  read: () => Promise<unknown>,
  baseline: unknown,
  cleanup: () => Promise<void>,
): Promise<void> {
  const sentinel = new Error("failure before fixture teardown");
  try {
    await insert();
    await exists();
    try {
      throw sentinel;
    } catch (error) {
      assert.equal(error, sentinel);
    }
    // This read deliberately occurs after the simulated failure and before cleanup.
    assert.deepEqual(await read(), baseline);
  } finally {
    await cleanup();
  }
}

before(async () => {
  assertAdminEnvironment();
  await adminSql(`
    INSERT INTO drugs (id, name, active_ingredient, sponsor, first_pbs_listing_date, authority_scope)
    VALUES (${drugId}, ${sqlLiteral(`${token} production medicine`)}, ${sqlLiteral(`${token} ingredient`)}, 'authority test', '2025-01-01', 'production');
    INSERT INTO ingestion_runs (
      status, records_processed, pages_fetched, request_urls, schedule_code,
      schedule_effective_date, snapshot_complete, finished_at, authority_scope
    ) VALUES ('completed', 0, 0, '[]', ${scheduleCode}, CURRENT_DATE, true, '2098-01-01T00:00:00Z', 'production');
    INSERT INTO pbs_items (
      item_code, pbs_code, drug_id, brand_name, strength, form, pack_size, formulary,
      current_aemp, last_updated, first_listed_date, authority_scope
    ) VALUES (
      ${sqlLiteral(itemCode)}, ${sqlLiteral(`PBS-${itemCode}`)}, ${drugId}, ${sqlLiteral(`${token} production brand`)},
      '10 mg', 'tablet', '30', 'F1', 100, '2025-01-01', '2025-01-01', 'production'
    );
    INSERT INTO pharmacy_stock (user_id, item_code, quantity, purchase_price, purchase_date)
    VALUES (${sqlLiteral(userId)}, ${sqlLiteral(itemCode)}, 1, 100, '2025-01-01');
  `);

  const app = express();
  app.use(express.json());
  app.use(createReferenceRouter(db, testAuth));
  app.use(createStockRouter(db, testAuth));
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  try {
    await adminSql(`
      DELETE FROM predicted_reductions WHERE item_code = ${sqlLiteral(itemCode)};
      DELETE FROM schedule_changes WHERE drug_id = ${drugId};
      DELETE FROM pharmacy_stock WHERE user_id = ${sqlLiteral(userId)};
      DELETE FROM pbs_items WHERE item_code = ${sqlLiteral(itemCode)};
      DELETE FROM drugs WHERE id = ${drugId};
      DELETE FROM ingestion_runs WHERE authority_scope = ${sqlLiteral(scope)};
      DELETE FROM ingestion_runs WHERE schedule_code = ${scheduleCode} AND authority_scope = 'production';
    `);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await pool.end();
  }
});

test("authority matrix hides a misleading test-run prediction before teardown", async () => {
  const baseline = await request("/stock");
  let runId = "";
  await withFailureBeforeTeardown(
    async () => {
      runId = await adminSql(`INSERT INTO ingestion_runs (status, records_processed, pages_fetched, request_urls, authority_scope) VALUES ('completed', 0, 0, '[]', ${sqlLiteral(scope)}) RETURNING id;`);
      await adminSql(`INSERT INTO predicted_reductions (item_code, drug_id, predicted_date, reduction_type, predicted_percentage, predicted_new_price, confidence, subject_to_ministerial_discretion, source_note, authority_run_id) VALUES (${sqlLiteral(itemCode)}, ${drugId}, '2099-01-01', 'authority test', 99, 1, 'confirmed', false, 'test fixture', ${runId});`);
    },
    () => assertAdminRow("predicted_reductions", `authority_run_id = ${runId}`),
    () => request("/stock"),
    baseline,
    async () => {
      await adminSql(`DELETE FROM predicted_reductions WHERE authority_run_id = ${runId}; DELETE FROM ingestion_runs WHERE id = ${runId};`);
    },
  );
});

test("authority matrix hides a high-significance test-run schedule change before teardown", async () => {
  const baseline = await request("/dashboard");
  let runId = "";
  await withFailureBeforeTeardown(
    async () => {
      runId = await adminSql(`INSERT INTO ingestion_runs (status, records_processed, pages_fetched, request_urls, authority_scope) VALUES ('completed', 0, 0, '[]', ${sqlLiteral(scope)}) RETURNING id;`);
      await adminSql(`INSERT INTO schedule_changes (schedule_code, effective_date, change_type, li_item_id, drug_id, brand_name, significance, authority_run_id) VALUES (${scheduleCode}, CURRENT_DATE, 'price_change', ${sqlLiteral(`${token}_change`)}, ${drugId}, ${sqlLiteral(`${token} production brand`)}, 'high', ${runId});`);
    },
    () => assertAdminRow("schedule_changes", `authority_run_id = ${runId}`),
    () => request("/dashboard"),
    baseline,
    async () => {
      await adminSql(`DELETE FROM schedule_changes WHERE authority_run_id = ${runId}; DELETE FROM ingestion_runs WHERE id = ${runId};`);
    },
  );
});

test("authority matrix hides a colliding test-scoped drug search result before teardown", async () => {
  const baseline = await request(`/drugs?search=${encodeURIComponent(searchTerm)}`);
  const testDrugId = drugId + 1;
  await withFailureBeforeTeardown(
    async () => {
      await adminSql(`INSERT INTO drugs (id, name, active_ingredient, sponsor, first_pbs_listing_date, authority_scope) VALUES (${testDrugId}, ${sqlLiteral(searchTerm)}, 'test', 'test', '2025-01-01', ${sqlLiteral(scope)});`);
    },
    () => assertAdminRow("drugs", `id = ${testDrugId}`),
    () => request(`/drugs?search=${encodeURIComponent(searchTerm)}`),
    baseline,
    async () => {
      await adminSql(`DELETE FROM drugs WHERE id = ${testDrugId};`);
    },
  );
});

test("authority matrix hides a colliding test-scoped item and brand search result before teardown", async () => {
  const baseline = await request(`/medicine-directory?search=${encodeURIComponent(searchTerm)}`);
  const testItemCode = `${token}_test_item`;
  await withFailureBeforeTeardown(
    async () => {
      await adminSql(`INSERT INTO pbs_items (item_code, pbs_code, drug_id, brand_name, formulary, current_aemp, last_updated, authority_scope) VALUES (${sqlLiteral(testItemCode)}, ${sqlLiteral(searchTerm)}, ${drugId}, ${sqlLiteral(searchTerm)}, 'F1', 1, '2025-01-01', ${sqlLiteral(scope)});`);
    },
    () => assertAdminRow("pbs_items", `item_code = ${sqlLiteral(testItemCode)}`),
    () => request(`/medicine-directory?search=${encodeURIComponent(searchTerm)}`),
    baseline,
    async () => {
      await adminSql(`DELETE FROM pbs_items WHERE item_code = ${sqlLiteral(testItemCode)};`);
    },
  );
});

test("authority matrix hides a newer completed and active test ingestion run before teardown", async () => {
  const baseline = await request("/dashboard");
  let completedId = "";
  let activeId = "";
  await withFailureBeforeTeardown(
    async () => {
      completedId = await adminSql(`INSERT INTO ingestion_runs (status, records_processed, pages_fetched, request_urls, schedule_code, schedule_effective_date, snapshot_complete, finished_at, authority_scope) VALUES ('completed', 0, 0, '[]', 999999, '2099-01-01', true, '2099-01-01T00:00:00Z', ${sqlLiteral(scope)}) RETURNING id;`);
      activeId = await adminSql(`INSERT INTO ingestion_runs (status, records_processed, pages_fetched, request_urls, authority_scope) VALUES ('running', 0, 0, '[]', ${sqlLiteral(scope)}) RETURNING id;`);
    },
    async () => {
      await assertAdminRow("ingestion_runs", `id = ${completedId}`);
      await assertAdminRow("ingestion_runs", `id = ${activeId}`);
    },
    () => request("/dashboard"),
    baseline,
    async () => {
      await adminSql(`DELETE FROM ingestion_runs WHERE id IN (${completedId}, ${activeId});`);
    },
  );
});