import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to apply the authority RLS boundary.");
}

const sqlFile = fileURLToPath(new URL("../sql/authority-rls.sql", import.meta.url));
const child = spawn(
  "psql",
  [
    process.env.DATABASE_URL,
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--file",
    sqlFile,
  ],
  { stdio: "inherit" },
);

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});