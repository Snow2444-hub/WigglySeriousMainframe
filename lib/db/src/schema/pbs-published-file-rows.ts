import { createInsertSchema } from "drizzle-zod";
import { boolean, date, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";
import { pbsPublishedFilesTable } from "./pbs-published-files";

export const pbsPublishedFileRowsTable = pgTable(
  "pbs_published_file_rows",
  {
    id: serial("id").primaryKey(),
    fileId: integer("file_id").notNull().references(() => pbsPublishedFilesTable.id),
    sourceRowNumber: integer("source_row_number").notNull(),
    rawRow: jsonb("raw_row").$type<Record<string, unknown>>().notNull(),
    sourceDrugName: text("source_drug_name"),
    sourceMoa: text("source_moa"),
    sourceItemCode: text("source_item_code"),
    matchedDrugId: integer("matched_drug_id").references(() => drugsTable.id),
    matchedItemCodes: jsonb("matched_item_codes").$type<string[]>().notNull().default([]),
    matchStatus: text("match_status").notNull(),
    failureReason: text("failure_reason"),
    isWatchlistMatch: boolean("is_watchlist_match").notNull().default(false),
    isNewEntry: boolean("is_new_entry").notNull().default(false),
    effectDate: date("effect_date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("pbs_published_file_rows_file_row_idx").on(table.fileId, table.sourceRowNumber)],
);

export const insertPbsPublishedFileRowSchema = createInsertSchema(pbsPublishedFileRowsTable).omit({ id: true });
export type InsertPbsPublishedFileRow = z.infer<typeof insertPbsPublishedFileRowSchema>;
export type PbsPublishedFileRow = typeof pbsPublishedFileRowsTable.$inferSelect;