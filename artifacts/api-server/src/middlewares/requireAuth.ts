import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.userId = userId;
  next();
}