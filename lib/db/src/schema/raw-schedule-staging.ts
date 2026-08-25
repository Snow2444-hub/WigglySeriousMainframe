import { createInsertSchema } from "drizzle-zod";
import { date, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const rawScheduleStagingTable = pgTable(
  "raw_schedule_staging",
  {
    id: serial("id").primaryKey(),
    scheduleDate: date("schedule_date", { mode: "string" }).notNull(),
    endpoint: text("endpoint").notNull(),
    pageNumber: integer("page_number").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("raw_schedule_staging_schedule_endpoint_page_idx").on(
      table.scheduleDate,
      table.endpoint,
      table.pageNumber,
    ),
  ],
);

export const insertRawScheduleStagingSchema = createInsertSchema(rawScheduleStagingTable).omit({ id: true });
export type InsertRawScheduleStaging = z.infer<typeof insertRawScheduleStagingSchema>;
export type RawScheduleStaging = typeof rawScheduleStagingTable.$inferSelect;