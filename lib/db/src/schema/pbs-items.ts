import { createInsertSchema } from "drizzle-zod";
import { date, integer, numeric, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";

export const formularyEnum = pgEnum("formulary", ["F1", "F2"]);

export const pbsItemsTable = pgTable("pbs_items", {
  itemCode: text("item_code").primaryKey(),
  drugId: integer("drug_id").notNull().references(() => drugsTable.id),
  brandName: text("brand_name").notNull(),
  formulary: formularyEnum("formulary").notNull(),
  currentAemp: numeric("current_aemp", { precision: 10, scale: 2, mode: "number" }).notNull(),
  currentDpmq: numeric("current_dpmq", { precision: 10, scale: 2, mode: "number" }).notNull(),
  lastUpdated: date("last_updated", { mode: "string" }).notNull(),
});

export const insertPbsItemSchema = createInsertSchema(pbsItemsTable);
export type InsertPbsItem = z.infer<typeof insertPbsItemSchema>;
export type PbsItem = typeof pbsItemsTable.$inferSelect;