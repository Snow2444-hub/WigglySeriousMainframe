import { Router, type IRouter } from "express";
import { runScheduledIngestion } from "../lib/scheduled-ingestion";
import {
  SCHEDULED_INGESTION_TOKEN_ENV,
  scheduledIngestionTokenMatches,
} from "../lib/scheduled-ingestion-auth";

const router: IRouter = Router();

router.post("/admin/run-scheduled-ingestion", async (req, res): Promise<void> => {
  const authorization = req.header("authorization");
  const providedToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
  const expectedToken = process.env[SCHEDULED_INGESTION_TOKEN_ENV];

  if (!expectedToken) {
    req.log.error(
      { envVar: SCHEDULED_INGESTION_TOKEN_ENV },
      "Scheduled ingestion endpoint is not configured",
    );
    res.status(503).json({ error: "Scheduled ingestion endpoint is not configured" });
    return;
  }
  if (!scheduledIngestionTokenMatches(expectedToken, providedToken)) {
    req.log.warn(
      {
        receivedTokenLength: Buffer.byteLength(providedToken ?? "", "utf8"),
        expectedTokenLength: Buffer.byteLength(expectedToken, "utf8"),
      },
      "Scheduled ingestion endpoint rejected bearer token",
    );
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const result = await runScheduledIngestion();
    if (result.status === "failed") {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "Authenticated scheduled PBS ingestion request failed");
    res.status(500).json({ error: "Scheduled ingestion could not be started" });
  }
});

export default router;