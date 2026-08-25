import { createInsertSchema } from "drizzle-zod";
import { date, integer, numeric, pgTable, serial, text } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { pbsItemsTable } from "./pbs-items";

export const pharmacyStockTable = pgTable("pharmacy_stock", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  itemCode: text("item_code").notNull().references(() => pbsItemsTable.itemCode),
  quantity: integer("quantity").notNull(),
  purchasePrice: numeric("purchase_price", { precision: 10, scale: 2, mode: "number" }).notNull(),
  purchaseDate: date("purchase_date", { mode: "string" }).notNull(),
});

export const insertPharmacyStockSchema = createInsertSchema(pharmacyStockTable).omit({ id: true });
export type InsertPharmacyStock = z.infer<typeof insertPharmacyStockSchema>;
export type PharmacyStock = typeof pharmacyStockTable.$inferSelect;