import { createInsertSchema } from "drizzle-zod";
import { date, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";
import { pbsItemsTable } from "./pbs-items";
import { pbsPublishedFilesTable } from "./pbs-published-files";

export const pbsPublishedPricesTable = pgTable(
  "pbs_published_prices",
  {
    id: serial("id").primaryKey(),
    fileId: integer("file_id").notNull().references(() => pbsPublishedFilesTable.id),
    sourceRowNumber: integer("source_row_number").notNull(),
    sourceItemCode: text("source_item_code").notNull(),
    matchedItemCode: text("matched_item_code").notNull().references(() => pbsItemsTable.itemCode),
    drugId: integer("drug_id").notNull().references(() => drugsTable.id),
    legalInstrumentDrug: text("legal_instrument_drug").notNull(),
    legalInstrumentMoa: text("legal_instrument_moa").notNull(),
    brandName: text("brand_name").notNull(),
    currentAemp: numeric("current_aemp", { precision: 12, scale: 4, mode: "number" }).notNull(),
    newAemp: numeric("new_aemp", { precision: 12, scale: 4, mode: "number" }).notNull(),
    predictedDate: date("predicted_date", { mode: "string" }).notNull(),
    confidence: text("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pbs_published_prices_file_row_item_idx").on(
      table.fileId,
      table.sourceRowNumber,
      table.matchedItemCode,
    ),
  ],
);

export const insertPbsPublishedPriceSchema = createInsertSchema(pbsPublishedPricesTable).omit({ id: true });
export type InsertPbsPublishedPrice = z.infer<typeof insertPbsPublishedPriceSchema>;
export type PbsPublishedPrice = typeof pbsPublishedPricesTable.$inferSelect;