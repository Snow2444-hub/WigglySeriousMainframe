import { createInsertSchema } from "drizzle-zod";
import { boolean, integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const reductionSettingsTable = pgTable("reduction_settings", {
  anniversaryYears: integer("anniversary_years").primaryKey(),
  reductionType: text("reduction_type").notNull(),
  percentage: numeric("percentage", { precision: 6, scale: 3, mode: "number" }).notNull(),
  triggerType: text("trigger_type").notNull().default("anniversary"),
  subjectToMinisterialDiscretion: boolean("subject_to_ministerial_discretion").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const insertReductionSettingSchema = createInsertSchema(reductionSettingsTable);
export type InsertReductionSetting = z.infer<typeof insertReductionSettingSchema>;
export type ReductionSetting = typeof reductionSettingsTable.$inferSelect;