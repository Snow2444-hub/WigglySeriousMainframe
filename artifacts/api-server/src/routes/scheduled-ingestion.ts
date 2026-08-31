import { Router, type IRouter } from "express";
import {
  startScheduledIngestion,
  type ScheduledIngestionAcceptedResult,
} from "../lib/scheduled-ingestion";
import {
  SCHEDULED_INGESTION_TOKEN_ENV,
  scheduledIngestionTokenMatches,
} from "../lib/scheduled-ingestion-auth";
import {
  startTgaShortagesIngestion,
  TGA_SHORTAGES_TOKEN_ENV,
  type TgaIngestionScope,
} from "../lib/tga-shortages";

export type ScheduledIngestionStarter = () => Promise<ScheduledIngestionAcceptedResult>;

export function createScheduledIngestionRouter(
  startIngestion: ScheduledIngestionStarter = startScheduledIngestion,
): IRouter {
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
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const result = await startIngestion();
      res.status(202).json(result);
    } catch (error) {
      req.log.error({ err: error }, "Authenticated scheduled PBS ingestion request failed");
      res.status(500).json({ error: "Scheduled ingestion could not be started" });
    }
  });

  router.post("/admin/run-tga-shortages-ingestion", async (req, res): Promise<void> => {
    const authorization = req.header("authorization");
    const providedToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : undefined;
    const expectedToken = process.env[TGA_SHORTAGES_TOKEN_ENV];
    if (!expectedToken) {
      res.status(503).json({ error: "TGA shortages ingestion endpoint is not configured" });
      return;
    }
    if (!scheduledIngestionTokenMatches(expectedToken, providedToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const source = req.body?.source ?? "active";
    if (!["active", "archive", "both"].includes(source)) {
      res.status(400).json({ error: "source must be active, archive, or both" });
      return;
    }
    try {
      const result = await startTgaShortagesIngestion(source as TgaIngestionScope);
      res.status(202).json(result);
    } catch (error) {
      req.log.error({ err: error, source }, "Authenticated TGA shortages ingestion request failed");
      res.status(500).json({ error: "TGA shortages ingestion could not be started" });
    }
  });

  return router;
}

export default createScheduledIngestionRouter();