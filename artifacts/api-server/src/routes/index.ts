import { Router, type IRouter } from "express";
import healthRouter from "./health";
import referenceRouter from "./reference";
import stockRouter from "./stock";
import meRouter from "./me";
import adminRouter from "./admin";
import brandPreferencesRouter from "./brand-preferences";
import tgaShortagesRouter from "./tga-shortages";

const router: IRouter = Router();

router.use(healthRouter);
router.use(referenceRouter);
router.use(stockRouter);
router.use(meRouter);
router.use(brandPreferencesRouter);
router.use(tgaShortagesRouter);
router.use(adminRouter);

export default router;
