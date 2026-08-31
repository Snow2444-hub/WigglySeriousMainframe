import { Router, type IRouter } from "express";
import { ListTgaShortagesQueryParams, ListTgaShortagesResponse } from "@workspace/api-zod";
import { listTgaShortages } from "../lib/tga-shortages";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/tga-shortages", requireAuth, async (req, res, next): Promise<void> => {
  const parsed = ListTgaShortagesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const params = parsed.data;
    const result = await listTgaShortages({
      mode: params.mode,
      section: params.section,
      availability: params.availability,
      impactRating: params.impactRating,
      watchedDrugId: params.watchedDrugId,
      search: params.search,
      page: params.page,
      limit: params.limit,
    });
    const response = {
      mode: params.mode,
      section: params.section ?? null,
      rows: result.rows,
      total: result.total,
      page: params.page,
      limit: params.limit,
      counts: result.counts,
      recentlyResolved: result.recentlyResolved,
      sourceHealth: {
        active: result.sourceHealth.active && {
          sourceKey: result.sourceHealth.active.sourceKey,
          label: result.sourceHealth.active.label,
          status: result.sourceHealth.active.status,
          cadenceLabel: result.sourceHealth.active.cadenceLabel,
          lastSuccessfulPullAt: result.sourceHealth.active.lastSuccessfulPullAt,
          staleAfterDate: result.sourceHealth.active.staleAfterDate,
          latestFailureStage: result.sourceHealth.active.latestFailureStage,
          latestFailureMessage: result.sourceHealth.active.latestFailureMessage,
        },
        archive: result.sourceHealth.archive && {
          sourceKey: result.sourceHealth.archive.sourceKey,
          label: result.sourceHealth.archive.label,
          status: result.sourceHealth.archive.status,
          cadenceLabel: result.sourceHealth.archive.cadenceLabel,
          lastSuccessfulPullAt: result.sourceHealth.archive.lastSuccessfulPullAt,
          staleAfterDate: result.sourceHealth.archive.staleAfterDate,
          latestFailureStage: result.sourceHealth.archive.latestFailureStage,
          latestFailureMessage: result.sourceHealth.archive.latestFailureMessage,
        },
        asOf: result.sourceHealth.asOf,
      },
    };
    const validated = ListTgaShortagesResponse.safeParse(response);
    if (!validated.success) throw new Error(`TGA shortage response failed validation: ${validated.error.message}`);
    res.json(validated.data);
  } catch (error) {
    next(error);
  }
});

export default router;