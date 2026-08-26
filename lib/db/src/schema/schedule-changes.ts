import { createInsertSchema } from "drizzle-zod";
import { date, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";

export const scheduleChangesTable = pgTable(
  "schedule_changes",
  {
    id: serial("id").primaryKey(),
    scheduleCode: integer("schedule_code").notNull(),
    effectiveDate: date("effective_date", { mode: "string" }).notNull(),
    changeType: text("change_type").notNull(),
    liItemId: text("li_item_id").notNull(),
    pbsCode: text("pbs_code"),
    drugId: integer("drug_id").notNull().references(() => drugsTable.id),
    brandName: text("brand_name"),
    oldValue: jsonb("old_value").$type<unknown>(),
    newValue: jsonb("new_value").$type<unknown>(),
    significance: text("significance").notNull().default("normal"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("schedule_changes_schedule_change_item_idx").on(
      table.scheduleCode,
      table.effectiveDate,
      table.changeType,
      table.liItemId,
    ),
  ],
);

export const insertScheduleChangeSchema = createInsertSchema(scheduleChangesTable).omit({ id: true });
export type InsertScheduleChange = z.infer<typeof insertScheduleChangeSchema>;
export type ScheduleChange = typeof scheduleChangesTable.$inferSelect;