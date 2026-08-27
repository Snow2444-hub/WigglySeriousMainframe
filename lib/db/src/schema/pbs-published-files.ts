import { createInsertSchema } from "drizzle-zod";
import { boolean, date, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const pbsPublishedFilesTable = pgTable(
  "pbs_published_files",
  {
    id: serial("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    pageUrl: text("page_url").notNull(),
    fileUrl: text("file_url").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type"),
    fileSha256: text("file_sha256").notNull(),
    rawContentBase64: text("raw_content_base64").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    parserVersion: text("parser_version").notNull(),
    status: text("status").notNull(),
    totalRows: integer("total_rows").notNull().default(0),
    matchedRows: integer("matched_rows").notNull().default(0),
    watchlistUnmatchedRows: integer("watchlist_unmatched_rows").notNull().default(0),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("pbs_published_files_source_key_idx").on(table.sourceKey)],
);

export const insertPbsPublishedFileSchema = createInsertSchema(pbsPublishedFilesTable).omit({ id: true });
export type InsertPbsPublishedFile = z.infer<typeof insertPbsPublishedFileSchema>;
export type PbsPublishedFile = typeof pbsPublishedFilesTable.$inferSelect;