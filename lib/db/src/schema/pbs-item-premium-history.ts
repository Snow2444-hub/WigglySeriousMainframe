import { createInsertSchema } from "drizzle-zod";
import { date, integer, numeric, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { pbsItemsTable } from "./pbs-items";

export const pbsItemPremiumHistoryTable = pgTable(
  "pbs_item_premium_history",
  {
    id: serial("id").primaryKey(),
    itemCode: text("item_code").notNull().references(() => pbsItemsTable.itemCode),
    liItemId: text("li_item_id").notNull(),
    scheduleCode: integer("schedule_code").notNull(),
    scheduleEffectiveDate: date("schedule_effective_date", { mode: "string" }).notNull(),
    dispensingRuleReference: text("dispensing_rule_reference").notNull(),
    dispensingRuleMnemonic: text("dispensing_rule_mnemonic"),
    brandPremium: numeric("brand_premium", { precision: 10, scale: 2, mode: "number" }),
    therapeuticGroupPremium: numeric("therapeutic_group_premium", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    therapeuticExemptionIndicator: text("therapeutic_exemption_indicator"),
  },
  (table) => [
    uniqueIndex("pbs_item_premium_history_item_schedule_rule_idx").on(
      table.itemCode,
      table.scheduleCode,
      table.scheduleEffectiveDate,
      table.dispensingRuleReference,
    ),
  ],
);

export const insertPbsItemPremiumHistorySchema = createInsertSchema(pbsItemPremiumHistoryTable).omit({ id: true });
export type InsertPbsItemPremiumHistory = z.infer<typeof insertPbsItemPremiumHistorySchema>;
export type PbsItemPremiumHistory = typeof pbsItemPremiumHistoryTable.$inferSelect;