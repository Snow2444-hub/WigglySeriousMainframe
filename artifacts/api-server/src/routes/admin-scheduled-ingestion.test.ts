import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import app from "../app";
import { SCHEDULED_INGESTION_TOKEN_ENV } from "../lib/scheduled-ingestion-auth";

async function withTestServer<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Test server did not bind to a TCP port");
  }

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("scheduled ingestion route rejects invalid bearer tokens", async () => {
  const previousToken = process.env[SCHEDULED_INGESTION_TOKEN_ENV];
  process.env[SCHEDULED_INGESTION_TOKEN_ENV] = "configured-cron-secret";

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/run-scheduled-ingestion`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-cron-secret" },
      });

      assert.equal(response.status, 401);
      assert.equal(response.headers.get("x-clerk-auth-status"), null);
      assert.deepEqual(await response.json(), { error: "Unauthorized" });
    });
  } finally {
    if (previousToken === undefined) delete process.env[SCHEDULED_INGESTION_TOKEN_ENV];
    else process.env[SCHEDULED_INGESTION_TOKEN_ENV] = previousToken;
  }
});

test("scheduled ingestion route reports missing configuration", async () => {
  const previousToken = process.env[SCHEDULED_INGESTION_TOKEN_ENV];
  delete process.env[SCHEDULED_INGESTION_TOKEN_ENV];

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/run-scheduled-ingestion`, {
        method: "POST",
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Scheduled ingestion endpoint is not configured",
      });
    });
  } finally {
    if (previousToken === undefined) delete process.env[SCHEDULED_INGESTION_TOKEN_ENV];
    else process.env[SCHEDULED_INGESTION_TOKEN_ENV] = previousToken;
  }
});