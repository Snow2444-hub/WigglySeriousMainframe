import { Router, type IRouter } from "express";
import healthRouter from "./health";
import referenceRouter from "./reference";
import stockRouter from "./stock";

const router: IRouter = Router();

router.use(healthRouter);
router.use(referenceRouter);
router.use(stockRouter);

export default router;
