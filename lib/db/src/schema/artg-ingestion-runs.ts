import { createInsertSchema } from "drizzle-zod";
import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const artgIngestionRunsTable = pgTable("artg_ingestion_runs", {
  id: serial("id").primaryKey(),
  sourceType: text("source_type").notNull().default("manual_upload"),
  sourceFileName: text("source_file_name").notNull(),
  contentType: text("content_type"),
  fileSha256: text("file_sha256").notNull(),
  parserVersion: text("parser_version").notNull(),
  status: text("status").notNull(),
  rowsRead: integer("rows_read").notNull().default(0),
  recordsAccepted: integer("records_accepted").notNull().default(0),
  recordsRejected: integer("records_rejected").notNull().default(0),
  recordsSkipped: integer("records_skipped").notNull().default(0),
  matchedDrugRecords: integer("matched_drug_records").notNull().default(0),
  pbsUnlistedRecords: integer("pbs_unlisted_records").notNull().default(0),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  errorMessage: text("error_message"),
});

export const insertArtgIngestionRunSchema = createInsertSchema(artgIngestionRunsTable).omit({ id: true });
export type InsertArtgIngestionRun = z.infer<typeof insertArtgIngestionRunSchema>;
export type ArtgIngestionRun = typeof artgIngestionRunsTable.$inferSelect;