import { createInsertSchema } from "drizzle-zod";
import { boolean, date, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";
import { pbsItemsTable } from "./pbs-items";

export const predictedReductionsTable = pgTable("predicted_reductions", {
  id: serial("id").primaryKey(),
  itemCode: text("item_code").notNull().references(() => pbsItemsTable.itemCode),
  drugId: integer("drug_id").notNull().references(() => drugsTable.id),
  predictedDate: date("predicted_date", { mode: "string" }).notNull(),
  reductionType: text("reduction_type").notNull(),
  predictedPercentage: numeric("predicted_percentage", { precision: 6, scale: 3, mode: "number" }).notNull(),
  predictedNewPrice: numeric("predicted_new_price", { precision: 12, scale: 4, mode: "number" }).notNull(),
  confidence: text("confidence").notNull(),
  subjectToMinisterialDiscretion: boolean("subject_to_ministerial_discretion").notNull().default(false),
  sourceNote: text("source_note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const insertPredictedReductionSchema = createInsertSchema(predictedReductionsTable).omit({ id: true });
export type InsertPredictedReduction = z.infer<typeof insertPredictedReductionSchema>;
export type PredictedReduction = typeof predictedReductionsTable.$inferSelect;