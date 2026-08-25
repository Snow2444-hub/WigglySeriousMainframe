import { createInsertSchema } from "drizzle-zod";
import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const ingestionRunsTable = pgTable("ingestion_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  status: text("status").notNull(),
  recordsProcessed: integer("records_processed").notNull().default(0),
  errorMessage: text("error_message"),
});

export const insertIngestionRunSchema = createInsertSchema(ingestionRunsTable).omit({ id: true });
export type InsertIngestionRun = z.infer<typeof insertIngestionRunSchema>;
export type IngestionRun = typeof ingestionRunsTable.$inferSelect;