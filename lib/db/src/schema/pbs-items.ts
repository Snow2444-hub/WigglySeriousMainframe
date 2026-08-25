import { createInsertSchema } from "drizzle-zod";
import { date, integer, numeric, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";

export const formularyEnum = pgEnum("formulary", ["F1", "F2"]);

export const pbsItemsTable = pgTable("pbs_items", {
  itemCode: text("item_code").primaryKey(),
  pbsCode: text("pbs_code"),
  liItemId: text("li_item_id"),
  scheduleCode: integer("schedule_code"),
  drugId: integer("drug_id").notNull().references(() => drugsTable.id),
  brandName: text("brand_name").notNull(),
  strength: text("strength"),
  form: text("form"),
  packSize: text("pack_size"),
  pricingQuantity: integer("pricing_quantity"),
  liForm: text("li_form"),
  programCode: text("program_code"),
  formulary: formularyEnum("formulary").notNull(),
  currentAemp: numeric("current_aemp", { precision: 10, scale: 2, mode: "number" }).notNull(),
  currentDpmq: numeric("current_dpmq", { precision: 10, scale: 2, mode: "number" }),
  lastUpdated: date("last_updated", { mode: "string" }).notNull(),
  firstListedDate: date("first_listed_date", { mode: "string" }),
  weightedAvgDisclosedPrice: numeric("weighted_avg_disclosed_price", {
    precision: 12,
    scale: 4,
    mode: "number",
  }),
  originatorBrandIndicator: text("originator_brand_indicator"),
  brandSubstitutionGroupId: text("brand_substitution_group_id"),
  advancedNoticeDate: date("advanced_notice_date", { mode: "string" }),
  nonEffectiveDate: date("non_effective_date", { mode: "string" }),
  determinedPrice: numeric("determined_price", { precision: 12, scale: 4, mode: "number" }),
  claimedPrice: numeric("claimed_price", { precision: 12, scale: 4, mode: "number" }),
  proportionalPrice: numeric("proportional_price", { precision: 12, scale: 4, mode: "number" }),
  therapeuticGroupId: text("therapeutic_group_id"),
  innovatorIndicator: text("innovator_indicator"),
});

export const insertPbsItemSchema = createInsertSchema(pbsItemsTable);
export type InsertPbsItem = z.infer<typeof insertPbsItemSchema>;
export type PbsItem = typeof pbsItemsTable.$inferSelect;