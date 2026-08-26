import { createInsertSchema } from "drizzle-zod";
import { date, integer, numeric, pgTable, serial, text } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { pbsItemsTable } from "./pbs-items";

export const priceHistoryTable = pgTable("price_history", {
  id: serial("id").primaryKey(),
  itemCode: text("item_code").notNull().references(() => pbsItemsTable.itemCode),
  priceDate: date("price_date", { mode: "string" }).notNull(),
  scheduleCode: integer("schedule_code").notNull(),
  scheduleEffectiveDate: date("schedule_effective_date", { mode: "string" }).notNull(),
  aemp: numeric("aemp", { precision: 10, scale: 2, mode: "number" }).notNull(),
  dpmq: numeric("dpmq", { precision: 10, scale: 2, mode: "number" }),
  reductionType: text("reduction_type"),
});

export const insertPriceHistorySchema = createInsertSchema(priceHistoryTable).omit({ id: true });
export type InsertPriceHistory = z.infer<typeof insertPriceHistorySchema>;
export type PriceHistory = typeof priceHistoryTable.$inferSelect;