import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/me", requireAuth, (req, res) => {
  res.json({
    id: req.userId,
    role: req.userRole,
  });
});

export default router;