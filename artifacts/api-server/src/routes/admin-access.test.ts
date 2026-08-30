import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import express, { type Request } from "express";
import pinoHttp from "pino-http";
import {
  artgIngestionRunsTable,
  db,
  ingestionRunsTable,
  pbsWatchlistTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import adminRouter from "./admin";
import meRouter from "./me";

const regularUserId = `admin_access_regular_${process.pid}`;
const adminUserId = `admin_access_admin_${process.pid}`;
const uploadFixtureName = `admin-access-upload-${process.pid}.csv`;
let baseUrl = "";
let server: Server;

function installFakeClerkAuth(req: Request, _res: unknown, next: () => void) {
  const userId = req.header("x-test-user") ?? undefined;
  const auth = Object.assign(
    () => ({ userId, tokenType: "session_token" }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  Object.defineProperty(req, "auth", { configurable: true, value: auth });
  next();
}

function request(userId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", userId);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

const adminEndpoints: Array<{
  label: string;
  method: string;
  path: string;
  expectedAdminStatus: number;
  body?: string;
  headers?: RequestInit["headers"];
}> = [
  {
    label: "list ingestion runs",
    method: "GET",
    path: "/admin/ingestion-runs",
    expectedAdminStatus: 200,
  },
  {
    label: "get current ingestion run",
    method: "GET",
    path: "/admin/ingestion-runs/current",
    expectedAdminStatus: 200,
  },
  {
    label: "start ingestion",
    method: "POST",
    path: "/admin/ingestion-runs",
    expectedAdminStatus: 400,
    body: JSON.stringify({ mode: "invalid" }),
  },
  {
    label: "cancel ingestion",
    method: "POST",
    path: "/admin/ingestion-runs/2147483647/cancel",
    expectedAdminStatus: 404,
  },
  {
    label: "list ARTG imports",
    method: "GET",
    path: "/admin/artg-imports",
    expectedAdminStatus: 200,
  },
  {
    label: "upload ARTG export",
    method: "POST",
    path: "/admin/artg-imports",
    expectedAdminStatus: 400,
    headers: {
      "content-type": "application/octet-stream",
      "x-artg-file-name": uploadFixtureName,
    },
  },
  {
    label: "list PBS source health",
    method: "GET",
    path: "/admin/pbs-source-status",
    expectedAdminStatus: 200,
  },
  {
    label: "list PBS watchlist",
    method: "GET",
    path: "/admin/pbs-watchlist",
    expectedAdminStatus: 200,
  },
  {
    label: "create PBS watchlist entry",
    method: "POST",
    path: "/admin/pbs-watchlist",
    expectedAdminStatus: 400,
    body: JSON.stringify({}),
  },
  {
    label: "update PBS watchlist entry",
    method: "PATCH",
    path: "/admin/pbs-watchlist/not-a-watchlist-id",
    expectedAdminStatus: 400,
    body: JSON.stringify({}),
  },
  {
    label: "delete PBS watchlist entry",
    method: "DELETE",
    path: "/admin/pbs-watchlist/not-a-watchlist-id",
    expectedAdminStatus: 400,
  },
  {
    label: "get significance settings",
    method: "GET",
    path: "/admin/schedule-change-settings",
    expectedAdminStatus: 200,
  },
  {
    label: "update significance settings",
    method: "PATCH",
    path: "/admin/schedule-change-settings",
    expectedAdminStatus: 400,
    body: JSON.stringify({
      mediumReductionPercentage: 20,
      highReductionPercentage: 10,
    }),
  },
];

before(async () => {
  await db
    .insert(usersTable)
    .values([
      { id: regularUserId, role: "user" },
      { id: adminUserId, role: "admin" },
    ])
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { role: "user" },
    });
  await db
    .update(usersTable)
    .set({ role: "admin" })
    .where(eq(usersTable.id, adminUserId));

  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(installFakeClerkAuth);
  app.use("/api", meRouter);
  app.use("/api", adminRouter);
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await db
    .delete(artgIngestionRunsTable)
    .where(eq(artgIngestionRunsTable.sourceFileName, uploadFixtureName));
  await db
    .delete(pbsWatchlistTable)
    .where(eq(pbsWatchlistTable.filterValue, "admin-access-fixture"));
  await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.errorMessage, "admin-access-fixture"));
  await db.delete(usersTable).where(eq(usersTable.id, regularUserId));
  await db.delete(usersTable).where(eq(usersTable.id, adminUserId));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("every Data updates endpoint rejects regular authenticated users", async () => {
  for (const endpoint of adminEndpoints) {
    const response = await request(regularUserId, `/api${endpoint.path}`, {
      method: endpoint.method,
      body: endpoint.body,
      headers: endpoint.headers,
    });
    assert.equal(response.status, 403, `${endpoint.label} must reject regular users`);
  }
});

test("every Data updates endpoint allows admins through to its handler", async () => {
  for (const endpoint of adminEndpoints) {
    const response = await request(adminUserId, `/api${endpoint.path}`, {
      method: endpoint.method,
      body: endpoint.body,
      headers: endpoint.headers,
    });
    assert.equal(
      response.status,
      endpoint.expectedAdminStatus,
      `${endpoint.label} should reach its handler for admins`,
    );
    assert.notEqual(response.status, 403, `${endpoint.label} must not reject admins`);
  }
});

test("/api/me is available to authenticated users and reports their local role", async () => {
  const regularResponse = await request(regularUserId, "/api/me");
  assert.equal(regularResponse.status, 200);
  assert.deepEqual(await regularResponse.json(), {
    id: regularUserId,
    role: "user",
  });

  const adminResponse = await request(adminUserId, "/api/me");
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(await adminResponse.json(), {
    id: adminUserId,
    role: "admin",
  });
});