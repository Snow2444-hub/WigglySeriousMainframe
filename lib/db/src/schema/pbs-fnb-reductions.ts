import { createInsertSchema } from "drizzle-zod";
import { boolean, date, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";
import { pbsPublishedFilesTable } from "./pbs-published-files";

export const pbsFnbReductionsTable = pgTable(
  "pbs_fnb_reductions",
  {
    id: serial("id").primaryKey(),
    fileId: integer("file_id").notNull().references(() => pbsPublishedFilesTable.id),
    sourceRowNumber: integer("source_row_number").notNull(),
    drugId: integer("drug_id").notNull().references(() => drugsTable.id),
    sourceDrugName: text("source_drug_name").notNull(),
    mannerOfAdministration: text("manner_of_administration").notNull(),
    effectDate: date("effect_date", { mode: "string" }).notNull(),
    isNewEntry: boolean("is_new_entry").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pbs_fnb_reductions_drug_moa_date_idx").on(
      table.drugId,
      table.mannerOfAdministration,
      table.effectDate,
    ),
    uniqueIndex("pbs_fnb_reductions_file_row_idx").on(table.fileId, table.sourceRowNumber),
  ],
);

export const insertPbsFnbReductionSchema = createInsertSchema(pbsFnbReductionsTable).omit({ id: true });
export type InsertPbsFnbReduction = z.infer<typeof insertPbsFnbReductionSchema>;
export type PbsFnbReduction = typeof pbsFnbReductionsTable.$inferSelect;