import { createInsertSchema } from "drizzle-zod";
import { date, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";
import { ingestionRunsTable } from "./ingestion-runs";

export type ScheduleChangeAffectedItem = {
  liItemId: string;
  pbsCode: string | null;
  brandName: string;
  strength: string | null;
  determinedPrice: number | null;
  formulary: "F1" | "F2" | null;
};

export const scheduleChangesTable = pgTable(
  "schedule_changes",
  {
    id: serial("id").primaryKey(),
    scheduleCode: integer("schedule_code").notNull(),
    effectiveDate: date("effective_date", { mode: "string" }).notNull(),
    changeType: text("change_type").notNull(),
    liItemId: text("li_item_id"),
    pbsCode: text("pbs_code"),
    drugId: integer("drug_id").notNull().references(() => drugsTable.id),
    brandName: text("brand_name"),
    oldValue: jsonb("old_value").$type<unknown>(),
    newValue: jsonb("new_value").$type<unknown>(),
    affectedItems: jsonb("affected_items").$type<ScheduleChangeAffectedItem[] | null>(),
    significance: text("significance").notNull().default("normal"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    authorityRunId: integer("authority_run_id").notNull().references(() => ingestionRunsTable.id),
  },
  (table) => [
    index("schedule_changes_authority_run_idx").on(table.authorityRunId),
    uniqueIndex("schedule_changes_schedule_change_item_idx").on(
      table.scheduleCode,
      table.effectiveDate,
      table.changeType,
      table.liItemId,
    ),
    uniqueIndex("schedule_changes_new_brand_drug_brand_idx")
      .on(table.scheduleCode, table.effectiveDate, table.drugId, table.brandName)
      .where(sql`change_type = 'new_brand'`),
  ],
);

export const insertScheduleChangeSchema = createInsertSchema(scheduleChangesTable).omit({ id: true });
export type InsertScheduleChange = z.infer<typeof insertScheduleChangeSchema>;
export type ScheduleChange = typeof scheduleChangesTable.$inferSelect;