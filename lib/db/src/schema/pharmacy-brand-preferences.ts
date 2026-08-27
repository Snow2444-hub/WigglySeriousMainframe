import { createInsertSchema } from "drizzle-zod";
import { boolean, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";

export const pharmacyBrandPreferencesTable = pgTable(
  "pharmacy_brand_preferences",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    drugId: integer("drug_id").notNull().references(() => drugsTable.id),
    brandKey: text("brand_key").notNull(),
    brandName: text("brand_name").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("pharmacy_brand_preference_user_brand_idx").on(table.userId, table.drugId, table.brandKey),
  ],
);

export const insertPharmacyBrandPreferenceSchema = createInsertSchema(pharmacyBrandPreferencesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPharmacyBrandPreference = z.infer<typeof insertPharmacyBrandPreferenceSchema>;
export type PharmacyBrandPreference = typeof pharmacyBrandPreferencesTable.$inferSelect;