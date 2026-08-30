import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const drugsTable = pgTable(
  "drugs",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    activeIngredient: text("active_ingredient").notNull(),
    sponsor: text("sponsor").notNull(),
    firstPbsListingDate: date("first_pbs_listing_date", { mode: "string" }).notNull(),
    authorityScope: text("authority_scope"),
  },
  (table) => [
    index("drugs_authority_scope_idx").on(table.authorityScope),
    check(
      "drugs_authority_scope_check",
      sql`${table.authorityScope} IS NULL OR ${table.authorityScope} = 'production' OR ${table.authorityScope} LIKE 'test:%'`,
    ),
  ],
);

export const insertDrugSchema = createInsertSchema(drugsTable);
export type InsertDrug = z.infer<typeof insertDrugSchema>;
export type Drug = typeof drugsTable.$inferSelect;