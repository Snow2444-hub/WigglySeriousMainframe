import { createInsertSchema } from "drizzle-zod";
import { boolean, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const scheduleChangeSettingsTable = pgTable("schedule_change_settings", {
  settingKey: text("setting_key").primaryKey(),
  mediumReductionPercentage: numeric("medium_reduction_percentage", {
    precision: 6,
    scale: 3,
    mode: "number",
  }).notNull(),
  highReductionPercentage: numeric("high_reduction_percentage", {
    precision: 6,
    scale: 3,
    mode: "number",
  }).notNull(),
  firstNewBrandHighSignificance: boolean("first_new_brand_high_significance").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const insertScheduleChangeSettingSchema = createInsertSchema(scheduleChangeSettingsTable);
export type InsertScheduleChangeSetting = z.infer<typeof insertScheduleChangeSettingSchema>;
export type ScheduleChangeSetting = typeof scheduleChangeSettingsTable.$inferSelect;