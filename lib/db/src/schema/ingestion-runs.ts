import { createInsertSchema } from "drizzle-zod";
import { boolean, date, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const ingestionRunsTable = pgTable("ingestion_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  status: text("status").notNull(),
  recordsProcessed: integer("records_processed").notNull().default(0),
  pagesFetched: integer("pages_fetched").notNull().default(0),
  requestUrls: jsonb("request_urls").$type<string[]>().notNull().default([]),
  errorMessage: text("error_message"),
  mode: text("mode").notNull().default("current"),
  scheduleDate: date("schedule_date", { mode: "string" }),
  maxPages: integer("max_pages"),
  totalSchedules: integer("total_schedules"),
  schedulesProcessed: integer("schedules_processed").notNull().default(0),
  scheduleCode: integer("schedule_code"),
  scheduleEffectiveDate: date("schedule_effective_date", { mode: "string" }),
  snapshotComplete: boolean("snapshot_complete").notNull().default(false),
});

export const insertIngestionRunSchema = createInsertSchema(ingestionRunsTable).omit({ id: true });
export type InsertIngestionRun = z.infer<typeof insertIngestionRunSchema>;
export type IngestionRun = typeof ingestionRunsTable.$inferSelect;