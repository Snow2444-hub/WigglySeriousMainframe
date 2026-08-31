import { createInsertSchema } from "drizzle-zod";
import { boolean, date, index, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";
import { pbsItemsTable } from "./pbs-items";
import { pbsPublishedFilesTable } from "./pbs-published-files";
import { ingestionRunsTable } from "./ingestion-runs";

export const predictedReductionsTable = pgTable(
  "predicted_reductions",
  {
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
    sourceFileId: integer("source_file_id").references(() => pbsPublishedFilesTable.id),
    sourceRowNumber: integer("source_row_number"),
    sourceValidUntil: date("source_valid_until", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    authorityRunId: integer("authority_run_id").notNull().references(() => ingestionRunsTable.id),
  },
  (table) => [index("predicted_reductions_authority_run_idx").on(table.authorityRunId)],
);

export const insertPredictedReductionSchema = createInsertSchema(predictedReductionsTable).omit({ id: true });
export type InsertPredictedReduction = z.infer<typeof insertPredictedReductionSchema>;
export type PredictedReduction = typeof predictedReductionsTable.$inferSelect;