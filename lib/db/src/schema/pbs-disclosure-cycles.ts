import { createInsertSchema } from "drizzle-zod";
import { date, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";
import { pbsPublishedFilesTable } from "./pbs-published-files";

export const pbsDisclosureCyclesTable = pgTable(
  "pbs_disclosure_cycles",
  {
    id: serial("id").primaryKey(),
    fileId: integer("file_id").notNull().references(() => pbsPublishedFilesTable.id),
    sourceRowNumber: integer("source_row_number").notNull(),
    drugId: integer("drug_id").notNull().references(() => drugsTable.id),
    legalInstrumentDrug: text("legal_instrument_drug").notNull(),
    legalInstrumentMoa: text("legal_instrument_moa").notNull(),
    cycleCode: text("cycle_code").notNull(),
    cycleLabel: text("cycle_label").notNull(),
    submissionDeadline: date("submission_deadline", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pbs_disclosure_cycles_drug_cycle_idx").on(table.drugId, table.cycleCode),
    uniqueIndex("pbs_disclosure_cycles_file_row_cycle_idx").on(table.fileId, table.sourceRowNumber, table.cycleCode),
  ],
);

export const insertPbsDisclosureCycleSchema = createInsertSchema(pbsDisclosureCyclesTable).omit({ id: true });
export type InsertPbsDisclosureCycle = z.infer<typeof insertPbsDisclosureCycleSchema>;
export type PbsDisclosureCycle = typeof pbsDisclosureCyclesTable.$inferSelect;