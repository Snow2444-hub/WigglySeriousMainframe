import { createInsertSchema } from "drizzle-zod";
import { date, integer, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const drugsTable = pgTable("drugs", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  activeIngredient: text("active_ingredient").notNull(),
  sponsor: text("sponsor").notNull(),
  firstPbsListingDate: date("first_pbs_listing_date", { mode: "string" }).notNull(),
});

export const insertDrugSchema = createInsertSchema(drugsTable);
export type InsertDrug = z.infer<typeof insertDrugSchema>;
export type Drug = typeof drugsTable.$inferSelect;