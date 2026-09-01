import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import {
  getDatabaseTargetFingerprint,
  inspectDatabaseAuthorityTarget,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/database-target", (_req, res) => {
  res.json(getDatabaseTargetFingerprint());
});

router.get("/healthz/database-status", async (_req, res) => {
  try {
    res.json(await inspectDatabaseAuthorityTarget());
  } catch (error) {
    res.status(503).json({
      status: "unreachable",
      error: error instanceof Error ? error.message : "Unknown database error",
    });
  }
});

export default router;
