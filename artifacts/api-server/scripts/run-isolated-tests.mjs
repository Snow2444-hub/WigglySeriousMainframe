import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import process from "node:process";

const apiServerRoot = new URL("..", import.meta.url).pathname;
const developmentDatabaseUrl = process.env.DATABASE_URL;
const dedicatedTestDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!developmentDatabaseUrl && !dedicatedTestDatabaseUrl) {
  throw new Error(
    "Isolated API tests require TEST_DATABASE_URL or DATABASE_URL so a per-run schema can be provisioned.",
  );
}

function databaseTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  return [url.protocol, url.hostname, url.port, url.pathname, url.username].join("|");
}

if (
  dedicatedTestDatabaseUrl &&
  developmentDatabaseUrl &&
  databaseTarget(dedicatedTestDatabaseUrl) === databaseTarget(developmentDatabaseUrl)
) {
    throw new Error("TEST_DATABASE_URL must not be the shared development DATABASE_URL.");
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid generated test schema identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function isolatedDatabaseUrl(databaseUrl, schema) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  url.search = `?${url.searchParams.toString().replaceAll("+", "%20")}`;
  return url.toString();
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: apiServerRoot,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function runCapture(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: apiServerRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

function runSchemaClone(sourceUrl, targetUrl, schema, env) {
  return new Promise((resolve, reject) => {
    const dump = spawn(
      "pg_dump",
      ["--schema-only", "--no-owner", "--no-privileges", "--schema=public", sourceUrl],
      { cwd: apiServerRoot, env, stdio: ["ignore", "pipe", "inherit"] },
    );
    const restore = spawn(
      "psql",
      [targetUrl, "--quiet", "--no-psqlrc", "--set", "ON_ERROR_STOP=1"],
      { cwd: apiServerRoot, env, stdio: ["pipe", "inherit", "inherit"] },
    );

    dump.stdout.on("data", (chunk) => {
      const rewritten = chunk
        .toString()
        .replaceAll("CREATE SCHEMA public;", `CREATE SCHEMA IF NOT EXISTS "${schema}";`)
        .replaceAll("public.", `"${schema}".`);
      restore.stdin.write(rewritten);
    });
    dump.stdout.on("end", () => restore.stdin.end());

    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    dump.once("error", reject);
    restore.once("error", reject);
    dump.once("exit", (code) => {
      if ((code ?? 1) !== 0) restore.stdin.destroy();
    });
    restore.once("exit", (code, signal) => finish(signal ? 1 : code ?? 1));
  });
}

function sqlStringLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function configureIsolatedSchemaRole(databaseUrl, quotedSchema, schema) {
  const testAuthorityScope = `test:${schema}`;
  const testAuthorityScopeLiteral = sqlStringLiteral(testAuthorityScope);
  const authorityScopePredicate =
    `(authority_scope = 'production' OR authority_scope = ${testAuthorityScopeLiteral})`;
  const authorityRunPredicate = `(EXISTS (
    SELECT 1
    FROM ${quotedSchema}.ingestion_runs authority_run
    WHERE authority_run.id = authority_run_id
      AND (authority_run.authority_scope = 'production'
        OR authority_run.authority_scope = ${testAuthorityScopeLiteral})
  ))`;

  return run(
    "psql",
    [
      databaseUrl,
      "--quiet",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      [
        `GRANT USAGE, CREATE ON SCHEMA ${quotedSchema} TO pbs_app`,
        `ALTER TABLE ${quotedSchema}.ingestion_runs OWNER TO pbs_app`,
        `ALTER TABLE ${quotedSchema}.drugs OWNER TO pbs_app`,
        `ALTER TABLE ${quotedSchema}.pbs_items OWNER TO pbs_app`,
        `ALTER TABLE ${quotedSchema}.predicted_reductions OWNER TO pbs_app`,
        `ALTER TABLE ${quotedSchema}.schedule_changes OWNER TO pbs_app`,
        `ALTER TABLE ${quotedSchema}.tga_shortage_observations OWNER TO pbs_app`,
        `ALTER TABLE ${quotedSchema}.tga_shortage_matches OWNER TO pbs_app`,
        `REVOKE CREATE ON SCHEMA ${quotedSchema} FROM pbs_app`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quotedSchema} TO pbs_app`,
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${quotedSchema} TO pbs_app`,
        `DROP POLICY IF EXISTS ingestion_runs_authority_policy ON ${quotedSchema}.ingestion_runs`,
        `CREATE POLICY ingestion_runs_authority_policy ON ${quotedSchema}.ingestion_runs
          USING (${authorityScopePredicate})
          WITH CHECK (${authorityScopePredicate})`,
        `DROP POLICY IF EXISTS drugs_authority_policy ON ${quotedSchema}.drugs`,
        `CREATE POLICY drugs_authority_policy ON ${quotedSchema}.drugs
          USING (${authorityScopePredicate})
          WITH CHECK (${authorityScopePredicate})`,
        `DROP POLICY IF EXISTS pbs_items_authority_policy ON ${quotedSchema}.pbs_items`,
        `CREATE POLICY pbs_items_authority_policy ON ${quotedSchema}.pbs_items
          USING (${authorityScopePredicate})
          WITH CHECK (${authorityScopePredicate})`,
        `DROP POLICY IF EXISTS predicted_reductions_authority_policy ON ${quotedSchema}.predicted_reductions`,
        `CREATE POLICY predicted_reductions_authority_policy ON ${quotedSchema}.predicted_reductions
          USING (${authorityRunPredicate})
          WITH CHECK (${authorityRunPredicate})`,
        `DROP POLICY IF EXISTS schedule_changes_authority_policy ON ${quotedSchema}.schedule_changes`,
        `CREATE POLICY schedule_changes_authority_policy ON ${quotedSchema}.schedule_changes
          USING (${authorityRunPredicate})
          WITH CHECK (${authorityRunPredicate})`,
        `DROP POLICY IF EXISTS tga_shortage_observations_authority_policy ON ${quotedSchema}.tga_shortage_observations`,
        `CREATE POLICY tga_shortage_observations_authority_policy ON ${quotedSchema}.tga_shortage_observations
          USING (${authorityRunPredicate})
          WITH CHECK (${authorityRunPredicate})`,
        `DROP POLICY IF EXISTS tga_shortage_matches_authority_policy ON ${quotedSchema}.tga_shortage_matches`,
        `CREATE POLICY tga_shortage_matches_authority_policy ON ${quotedSchema}.tga_shortage_matches
          USING (${authorityRunPredicate})
          WITH CHECK (${authorityRunPredicate})`,
      ].join("; "),
    ],
    process.env,
  );
}

const useDedicatedTestDatabase = Boolean(dedicatedTestDatabaseUrl);
const baseDatabaseUrl = dedicatedTestDatabaseUrl ?? developmentDatabaseUrl;
const schema = useDedicatedTestDatabase ? null : `test_${process.pid}_${Date.now()}`.slice(0, 55);
const quotedSchema = schema ? quoteIdentifier(schema) : null;
const isolatedUrl = schema ? isolatedDatabaseUrl(baseDatabaseUrl, schema) : baseDatabaseUrl;
const childEnv = {
  ...process.env,
  DATABASE_URL: isolatedUrl,
  NODE_ENV: "test",
};
const testFiles = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [...globSync("src/routes/*.test.ts"), ...globSync("src/lib/*.test.ts")].sort();

let exitCode = 1;
let schemaCreated = false;

try {
  if (useDedicatedTestDatabase) {
    childEnv.TEST_ISOLATION_SCHEMA = "public";
    childEnv.TEST_ISOLATION_DATABASE = "dedicated";
    exitCode = await run(
      "pnpm",
      ["--filter", "@workspace/db", "run", "push"],
      { ...process.env, DATABASE_URL: isolatedUrl, CI: "true" },
    );
    if (exitCode !== 0) throw new Error("Could not provision TEST_DATABASE_URL.");
    exitCode = await run(
      "pnpm",
      ["--filter", "@workspace/db", "run", "authority:apply"],
      { ...process.env, DATABASE_URL: isolatedUrl },
    );
    if (exitCode !== 0) throw new Error("Could not apply authority RLS to TEST_DATABASE_URL.");
    exitCode = await configureIsolatedSchemaRole(baseDatabaseUrl, quoteIdentifier("public"), "public");
    if (exitCode !== 0) throw new Error("Could not configure the isolated test application role.");
  } else {
    childEnv.TEST_ISOLATION_SCHEMA = schema;
    childEnv.TEST_ISOLATION_DATABASE = "per-run-schema";
    exitCode = await run(
      "psql",
      [
        baseDatabaseUrl,
        "--quiet",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        `CREATE SCHEMA ${quotedSchema}`,
      ],
      process.env,
    );
    if (exitCode !== 0) {
      throw new Error(
        "Could not create a per-run test schema. Set TEST_DATABASE_URL to a dedicated database and rerun; refusing the shared development database.",
      );
    }
    schemaCreated = true;

    exitCode = await runSchemaClone(baseDatabaseUrl, isolatedUrl, schema, process.env);
    if (exitCode !== 0) throw new Error("Could not provision the isolated test schema.");
    exitCode = await configureIsolatedSchemaRole(baseDatabaseUrl, quotedSchema, schema);
    if (exitCode !== 0) throw new Error("Could not configure the isolated test application role.");
  }

  const schemaCheck = await runCapture(
    "psql",
    [
      isolatedUrl,
      "--tuples-only",
      "--no-align",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `SELECT CASE WHEN current_schema() = '${schema ?? "public"}' AND to_regclass('${schema ?? "public"}.drugs') IS NOT NULL AND to_regclass('${schema ?? "public"}.ingestion_runs') IS NOT NULL THEN 'ok' ELSE 'not_ok' END`,
    ],
    process.env,
  );
  if (schemaCheck.code !== 0 || schemaCheck.stdout.trim() !== "ok") {
    throw new Error(
      `Isolated database verification failed; refusing to run tests outside ${schema ?? "the dedicated test database"}.`,
    );
  }

  exitCode = await run(
    "../../scripts/node_modules/.bin/tsx",
    ["--test", "--test-concurrency=1", ...testFiles],
    childEnv,
  );
} finally {
  if (schemaCreated) {
    const cleanupCode = await run(
      "psql",
      [
        baseDatabaseUrl,
        "--quiet",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        `DROP SCHEMA ${quotedSchema} CASCADE`,
      ],
      process.env,
    );
    if (cleanupCode !== 0 && exitCode === 0) exitCode = cleanupCode;
  }
}

process.exitCode = exitCode;