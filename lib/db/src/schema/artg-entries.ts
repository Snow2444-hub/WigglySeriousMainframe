import { createInsertSchema } from "drizzle-zod";
import { date, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const artgEntriesTable = pgTable("artg_entries", {
  artgId: text("artg_id").primaryKey(),
  activeIngredient: text("active_ingredient").notNull(),
  sponsor: text("sponsor").notNull(),
  registrationDate: date("registration_date", { mode: "string" }).notNull(),
  productName: text("product_name").notNull(),
  status: text("status").notNull(),
});

export const insertArtgEntrySchema = createInsertSchema(artgEntriesTable);
export type InsertArtgEntry = z.infer<typeof insertArtgEntrySchema>;
export type ArtgEntry = typeof artgEntriesTable.$inferSelect;