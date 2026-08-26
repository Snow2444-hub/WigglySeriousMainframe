import { createInsertSchema } from "drizzle-zod";
import { integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const priceDisclosureSettingsTable = pgTable("price_disclosure_settings", {
  id: serial("id").primaryKey(),
  settingKey: text("setting_key").notNull().unique(),
  reductionMonth: integer("reduction_month").notNull(),
  reductionDay: integer("reduction_day").notNull(),
  minimumGapPercentage: numeric("minimum_gap_percentage", {
    precision: 6,
    scale: 3,
    mode: "number",
  }).notNull(),
  highConfidenceGapPercentage: numeric("high_confidence_gap_percentage", {
    precision: 6,
    scale: 3,
    mode: "number",
  }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const insertPriceDisclosureSettingSchema = createInsertSchema(
  priceDisclosureSettingsTable,
).omit({ id: true });
export type InsertPriceDisclosureSetting = z.infer<typeof insertPriceDisclosureSettingSchema>;
export type PriceDisclosureSetting = typeof priceDisclosureSettingsTable.$inferSelect;