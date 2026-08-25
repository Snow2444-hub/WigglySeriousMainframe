import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, pharmacyStockTable, pbsItemsTable } from "@workspace/db";
import {
  CreateStockBody,
  CreateStockResponse,
  DashboardSummary,
  DeleteStockParams,
  GetDashboardResponse,
  ListStockResponse,
  UpdateStockBody,
  UpdateStockParams,
  UpdateStockResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

const stockSelect = {
  id: pharmacyStockTable.id,
  userId: pharmacyStockTable.userId,
  itemCode: pharmacyStockTable.itemCode,
  brandName: pbsItemsTable.brandName,
  quantity: pharmacyStockTable.quantity,
  purchasePrice: pharmacyStockTable.purchasePrice,
  purchaseDate: pharmacyStockTable.purchaseDate,
};

async function getUserStock(userId: string) {
  return db
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .where(eq(pharmacyStockTable.userId, userId))
    .orderBy(desc(pharmacyStockTable.purchaseDate), desc(pharmacyStockTable.id));
}

router.get("/dashboard", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const rows = await getUserStock(userId);
  const itemCodes = new Set(rows.map((row) => row.itemCode));
  const itemDetails = itemCodes.size
    ? await db
        .select({ itemCode: pbsItemsTable.itemCode, formulary: pbsItemsTable.formulary })
        .from(pbsItemsTable)
        .where(sql`${pbsItemsTable.itemCode} in (${sql.join([...itemCodes].map((code) => sql`${code}`), sql`, `)})`)
    : [];
  const formularyBreakdown = itemDetails.reduce(
    (breakdown, item) => {
      breakdown[item.formulary] += 1;
      return breakdown;
    },
    { F1: 0, F2: 0 },
  );
  const summary = {
    totalStockUnits: rows.reduce((total, row) => total + row.quantity, 0),
    stockLineCount: rows.length,
    trackedItems: itemCodes.size,
    formularyBreakdown,
    recentStock: rows.slice(0, 5),
  };
  res.json(GetDashboardResponse.parse(summary));
});

router.get("/stock", requireAuth, async (req, res): Promise<void> => {
  const rows = await getUserStock(req.userId!);
  res.json(ListStockResponse.parse(rows));
});

router.post("/stock", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateStockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [item] = await db
    .select({ itemCode: pbsItemsTable.itemCode })
    .from(pbsItemsTable)
    .where(eq(pbsItemsTable.itemCode, parsed.data.itemCode));
  if (!item) {
    res.status(400).json({ error: "PBS item code not found" });
    return;
  }
  const [created] = await db
    .insert(pharmacyStockTable)
    .values({
      ...parsed.data,
      userId: req.userId!,
      purchaseDate: parsed.data.purchaseDate.toISOString().slice(0, 10),
    })
    .returning({ id: pharmacyStockTable.id });
  const [row] = await db
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .where(and(eq(pharmacyStockTable.id, created.id), eq(pharmacyStockTable.userId, req.userId!)));
  res.status(201).json(CreateStockResponse.parse(row));
});

router.patch("/stock/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateStockParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateStockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.itemCode) {
    const [item] = await db
      .select({ itemCode: pbsItemsTable.itemCode })
      .from(pbsItemsTable)
      .where(eq(pbsItemsTable.itemCode, parsed.data.itemCode));
    if (!item) {
      res.status(400).json({ error: "PBS item code not found" });
      return;
    }
  }
  const updateData = {
    ...(parsed.data.itemCode !== undefined ? { itemCode: parsed.data.itemCode } : {}),
    ...(parsed.data.quantity !== undefined ? { quantity: parsed.data.quantity } : {}),
    ...(parsed.data.purchasePrice !== undefined
      ? { purchasePrice: parsed.data.purchasePrice }
      : {}),
    ...(parsed.data.purchaseDate !== undefined
      ? { purchaseDate: parsed.data.purchaseDate.toISOString().slice(0, 10) }
      : {}),
  };
  const [updated] = await db
    .update(pharmacyStockTable)
    .set(updateData)
    .where(and(eq(pharmacyStockTable.id, params.data.id), eq(pharmacyStockTable.userId, req.userId!)))
    .returning({ id: pharmacyStockTable.id });
  if (!updated) {
    res.status(404).json({ error: "Stock record not found" });
    return;
  }
  const [row] = await db
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .where(and(eq(pharmacyStockTable.id, updated.id), eq(pharmacyStockTable.userId, req.userId!)));
  res.json(UpdateStockResponse.parse(row));
});

router.delete("/stock/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteStockParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(pharmacyStockTable)
    .where(and(eq(pharmacyStockTable.id, params.data.id), eq(pharmacyStockTable.userId, req.userId!)))
    .returning({ id: pharmacyStockTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Stock record not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;