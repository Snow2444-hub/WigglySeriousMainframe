import { createInsertSchema } from "drizzle-zod";
import { boolean, pgEnum, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const pbsWatchlistFilterTypeEnum = pgEnum("pbs_watchlist_filter_type", [
  "brand_name",
  "drug_name",
  "pbs_code",
  "formulary",
  "program_code",
  "atc_code",
]);

export const pbsWatchlistTable = pgTable(
  "pbs_watchlist",
  {
    id: serial("id").primaryKey(),
    filterType: pbsWatchlistFilterTypeEnum("filter_type").notNull(),
    filterValue: text("filter_value").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("pbs_watchlist_filter_value_idx").on(table.filterType, table.filterValue)],
);

export const insertPbsWatchlistSchema = createInsertSchema(pbsWatchlistTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPbsWatchlist = z.infer<typeof insertPbsWatchlistSchema>;
export type PbsWatchlistEntry = typeof pbsWatchlistTable.$inferSelect;