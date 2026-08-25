import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type UserRole = "user" | "admin";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: UserRole;
    }
  }
}

async function ensureLocalUser(userId: string): Promise<UserRole> {
  const [existing] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (existing) return existing.role;

  const [created] = await db
    .insert(usersTable)
    .values({ id: userId })
    .onConflictDoNothing()
    .returning({ role: usersTable.role });

  if (created) return created.role;

  const [afterConflict] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  return afterConflict?.role ?? "user";
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    req.userId = userId;
    req.userRole = await ensureLocalUser(userId);
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const role = await ensureLocalUser(userId);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    req.userId = userId;
    req.userRole = role;
    next();
  } catch (error) {
    next(error);
  }
}