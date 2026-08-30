import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import process from "node:process";

const apiServerRoot = new URL("..", import.meta.url).pathname;
const baseDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!baseDatabaseUrl) {
  throw new Error(
    "Isolated API tests require TEST_DATABASE_URL or DATABASE_URL so a per-run schema can be provisioned.",
  );
}

if (process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  const testUrl = new URL(process.env.TEST_DATABASE_URL);
  const developmentUrl = new URL(process.env.DATABASE_URL);
  if (testUrl.toString() === developmentUrl.toString()) {
    throw new Error("TEST_DATABASE_URL must not be the shared development DATABASE_URL.");
  }
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

const schema = `test_${process.pid}_${Date.now()}`.slice(0, 55);
const quotedSchema = quoteIdentifier(schema);
const isolatedUrl = isolatedDatabaseUrl(baseDatabaseUrl, schema);
const childEnv = {
  ...process.env,
  DATABASE_URL: isolatedUrl,
  NODE_ENV: "test",
  TEST_ISOLATION_SCHEMA: schema,
};
const testFiles = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [...globSync("src/routes/*.test.ts"), ...globSync("src/lib/*.test.ts")].sort();

let exitCode = 1;
let schemaCreated = false;

try {
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
  if (exitCode !== 0) throw new Error("Could not create the isolated test schema.");
  schemaCreated = true;

  exitCode = await run(
    "pnpm",
    ["--filter", "@workspace/db", "run", "push"],
    { ...process.env, DATABASE_URL: isolatedUrl, CI: "true" },
  );
  if (exitCode !== 0) throw new Error("Could not provision the isolated test schema.");

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