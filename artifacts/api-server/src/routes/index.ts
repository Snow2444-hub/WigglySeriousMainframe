import { Router, type IRouter } from "express";
import healthRouter from "./health";
import referenceRouter from "./reference";
import stockRouter from "./stock";
import meRouter from "./me";

const router: IRouter = Router();

router.use(healthRouter);
router.use(referenceRouter);
router.use(stockRouter);
router.use(meRouter);

export default router;
