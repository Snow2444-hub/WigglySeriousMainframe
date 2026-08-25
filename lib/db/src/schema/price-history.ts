import { createInsertSchema } from "drizzle-zod";
import { date, numeric, pgTable, text, primaryKey } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { pbsItemsTable } from "./pbs-items";

export const priceHistoryTable = pgTable(
  "price_history",
  {
    itemCode: text("item_code").notNull().references(() => pbsItemsTable.itemCode),
    priceDate: date("price_date", { mode: "string" }).notNull(),
    aemp: numeric("aemp", { precision: 10, scale: 2, mode: "number" }).notNull(),
    dpmq: numeric("dpmq", { precision: 10, scale: 2, mode: "number" }).notNull(),
    reductionType: text("reduction_type"),
  },
  (table) => [primaryKey({ columns: [table.itemCode, table.priceDate] })],
);

export const insertPriceHistorySchema = createInsertSchema(priceHistoryTable);
export type InsertPriceHistory = z.infer<typeof insertPriceHistorySchema>;
export type PriceHistory = typeof priceHistoryTable.$inferSelect;