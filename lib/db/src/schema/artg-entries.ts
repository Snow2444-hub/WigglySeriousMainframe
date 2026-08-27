import { createInsertSchema } from "drizzle-zod";
import { date, integer, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { drugsTable } from "./drugs";

export const artgEntriesTable = pgTable("artg_entries", {
  artgId: text("artg_id").primaryKey(),
  activeIngredient: text("active_ingredient").notNull(),
  normalizedIngredient: text("normalized_ingredient").notNull().default(""),
  matchedDrugId: integer("matched_drug_id").references(() => drugsTable.id),
  sponsor: text("sponsor").notNull(),
  registrationDate: date("registration_date", { mode: "string" }).notNull(),
  productName: text("product_name").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull().default("legacy_seed"),
  ingestionRunId: integer("ingestion_run_id"),
});

export const insertArtgEntrySchema = createInsertSchema(artgEntriesTable);
export type InsertArtgEntry = z.infer<typeof insertArtgEntrySchema>;
export type ArtgEntry = typeof artgEntriesTable.$inferSelect;