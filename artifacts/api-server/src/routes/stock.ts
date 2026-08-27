import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  drugsTable,
  pharmacyStockTable,
  pbsItemsTable,
  predictedReductionsTable,
} from "@workspace/db";
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

export function createStockRouter(
  database: typeof db = db,
  authMiddleware: typeof requireAuth = requireAuth,
): IRouter {
  const router: IRouter = Router();

const stockSelect = {
  id: pharmacyStockTable.id,
  userId: pharmacyStockTable.userId,
  itemCode: pharmacyStockTable.itemCode,
  pbsCode: pbsItemsTable.pbsCode,
  brandName: pbsItemsTable.brandName,
  drugName: drugsTable.name,
  activeIngredient: drugsTable.activeIngredient,
  strength: pbsItemsTable.strength,
  form: pbsItemsTable.form,
  packSize: pbsItemsTable.packSize,
  benefitTypeCode: pbsItemsTable.benefitTypeCode,
  maximumQuantityUnits: pbsItemsTable.maximumQuantityUnits,
  formulary: pbsItemsTable.formulary,
  quantity: pharmacyStockTable.quantity,
  purchasePrice: pharmacyStockTable.purchasePrice,
  purchaseDate: pharmacyStockTable.purchaseDate,
  invoiceReference: pharmacyStockTable.invoiceReference,
};

async function getUserStock(userId: string) {
  return database
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(eq(pharmacyStockTable.userId, userId))
    .orderBy(desc(pharmacyStockTable.purchaseDate), desc(pharmacyStockTable.id));
}

async function getUserExposure(userId: string) {
  const rows = await getUserStock(userId);
  const itemCodes = [...new Set(rows.map((row) => row.itemCode))];
  const today = new Date().toISOString().slice(0, 10);
  const predictions = itemCodes.length
    ? await database
        .select({
          itemCode: predictedReductionsTable.itemCode,
          predictedDate: predictedReductionsTable.predictedDate,
          reductionType: predictedReductionsTable.reductionType,
          predictedPercentage: predictedReductionsTable.predictedPercentage,
          predictedNewPrice: predictedReductionsTable.predictedNewPrice,
          confidence: predictedReductionsTable.confidence,
        })
        .from(predictedReductionsTable)
        .where(
          and(
            inArray(predictedReductionsTable.itemCode, itemCodes),
            gte(predictedReductionsTable.predictedDate, today),
          ),
        )
        .orderBy(asc(predictedReductionsTable.predictedDate), asc(predictedReductionsTable.id))
    : [];

  const predictionByItemCode = new Map<
    string,
    (typeof predictions)[number]
  >();
  for (const prediction of predictions) {
    const existing = predictionByItemCode.get(prediction.itemCode);
    if (
      !existing
      || prediction.predictedDate < existing.predictedDate
      || (
        prediction.predictedDate === existing.predictedDate
        && prediction.confidence === "confirmed"
        && existing.confidence !== "confirmed"
      )
    ) {
      predictionByItemCode.set(prediction.itemCode, prediction);
    }
  }

  const exposureRows = rows.map((row) => {
    const prediction = predictionByItemCode.get(row.itemCode) ?? null;
    const perPackExposure = prediction
      ? Number(Math.max(0, row.purchasePrice - prediction.predictedNewPrice).toFixed(2))
      : 0;
    const totalExposure = Number((perPackExposure * row.quantity).toFixed(2));
    return {
      ...row,
      prediction,
      perPackExposure,
      totalExposure,
    };
  });

  exposureRows.sort((left, right) => {
    if (right.totalExposure !== left.totalExposure) {
      return right.totalExposure - left.totalExposure;
    }
    if (left.prediction && right.prediction) {
      const dateOrder = left.prediction.predictedDate.localeCompare(right.prediction.predictedDate);
      if (dateOrder !== 0) return dateOrder;
    }
    if (Boolean(right.prediction) !== Boolean(left.prediction)) {
      return right.prediction ? 1 : -1;
    }
    return right.id - left.id;
  });

  const byDate = new Map<string, { totalExposure: number; lineCount: number }>();
  for (const row of exposureRows) {
    if (!row.prediction) continue;
    const current = byDate.get(row.prediction.predictedDate) ?? { totalExposure: 0, lineCount: 0 };
    current.totalExposure = Number((current.totalExposure + row.totalExposure).toFixed(2));
    current.lineCount += 1;
    byDate.set(row.prediction.predictedDate, current);
  }
  const summary = {
    totalExposure: Number(
      exposureRows.reduce((total, row) => total + row.totalExposure, 0).toFixed(2),
    ),
    totalAtRiskLines: exposureRows.filter((row) => row.totalExposure > 0).length,
    exposureByDate: [...byDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([predictedDate, values]) => ({ predictedDate, ...values })),
  };

  return { rows: exposureRows, summary };
}

router.get("/dashboard", authMiddleware, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const rows = await getUserStock(userId);
  const itemCodes = new Set(rows.map((row) => row.itemCode));
  const itemDetails = itemCodes.size
    ? await database
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

router.get("/stock", authMiddleware, async (req, res): Promise<void> => {
  const exposure = await getUserExposure(req.userId!);
  res.json(ListStockResponse.parse(exposure));
});

router.post("/stock", authMiddleware, async (req, res): Promise<void> => {
  const parsed = CreateStockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [item] = await database
    .select({ itemCode: pbsItemsTable.itemCode })
    .from(pbsItemsTable)
    .where(eq(pbsItemsTable.itemCode, parsed.data.itemCode));
  if (!item) {
    res.status(400).json({ error: "PBS item code not found" });
    return;
  }
  const [created] = await database
    .insert(pharmacyStockTable)
    .values({
      ...parsed.data,
      userId: req.userId!,
      purchaseDate: parsed.data.purchaseDate.toISOString().slice(0, 10),
      invoiceReference: parsed.data.invoiceReference?.trim() || null,
    })
    .returning({ id: pharmacyStockTable.id });
  const [row] = await database
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(and(eq(pharmacyStockTable.id, created.id), eq(pharmacyStockTable.userId, req.userId!)));
  res.status(201).json(CreateStockResponse.parse(row));
});

router.patch("/stock/:id", authMiddleware, async (req, res): Promise<void> => {
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
    const [item] = await database
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
    ...(parsed.data.invoiceReference !== undefined
      ? { invoiceReference: parsed.data.invoiceReference?.trim() || null }
      : {}),
  };
  const [updated] = await database
    .update(pharmacyStockTable)
    .set(updateData)
    .where(and(eq(pharmacyStockTable.id, params.data.id), eq(pharmacyStockTable.userId, req.userId!)))
    .returning({ id: pharmacyStockTable.id });
  if (!updated) {
    res.status(404).json({ error: "Stock record not found" });
    return;
  }
  const [row] = await database
    .select(stockSelect)
    .from(pharmacyStockTable)
    .innerJoin(pbsItemsTable, eq(pharmacyStockTable.itemCode, pbsItemsTable.itemCode))
    .innerJoin(drugsTable, eq(pbsItemsTable.drugId, drugsTable.id))
    .where(and(eq(pharmacyStockTable.id, updated.id), eq(pharmacyStockTable.userId, req.userId!)));
  res.json(UpdateStockResponse.parse(row));
});

router.delete("/stock/:id", authMiddleware, async (req, res): Promise<void> => {
  const params = DeleteStockParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await database
    .delete(pharmacyStockTable)
    .where(and(eq(pharmacyStockTable.id, params.data.id), eq(pharmacyStockTable.userId, req.userId!)))
    .returning({ id: pharmacyStockTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Stock record not found" });
    return;
  }
  res.sendStatus(204);
});

  return router;
}

export default createStockRouter();