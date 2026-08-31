import { createInsertSchema } from "drizzle-zod";
import { date, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { ingestionRunsTable } from "./ingestion-runs";
import { pbsPublishedFilesTable } from "./pbs-published-files";
import { drugsTable } from "./drugs";
import { pbsWatchlistTable } from "./pbs-watchlist";

export const tgaShortageObservationsTable = pgTable(
  "tga_shortage_observations",
  {
    id: serial("id").primaryKey(),
    sourceFileId: integer("source_file_id").notNull().references(() => pbsPublishedFilesTable.id),
    sourceRowNumber: integer("source_row_number").notNull(),
    authorityRunId: integer("authority_run_id").notNull().references(() => ingestionRunsTable.id),
    sourceKind: text("source_kind").notNull(),
    artgId: text("artg_id").notNull(),
    artgName: text("artg_name").notNull(),
    activeIngredients: text("active_ingredients").notNull(),
    dosageForm: text("dosage_form").notNull(),
    quantityOfActiveIngredients: text("quantity_of_active_ingredients"),
    sponsor: text("sponsor").notNull(),
    phone: text("phone"),
    shortageStatus: text("shortage_status"),
    supplyImpactStartDate: date("supply_impact_start_date", { mode: "string" }),
    supplyImpactEndDate: date("supply_impact_end_date", { mode: "string" }),
    deletionFromMarket: date("deletion_from_market", { mode: "string" }),
    shortageImpactRating: text("shortage_impact_rating"),
    availability: text("availability"),
    reason: text("reason"),
    managementAction: text("management_action"),
    lastUpdated: date("last_updated", { mode: "string" }),
    episodeKey: text("episode_key").notNull(),
    canonicalHash: text("canonical_hash").notNull(),
    rawRow: jsonb("raw_row").$type<Record<string, string | null>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tga_shortage_observations_file_row_idx").on(table.sourceFileId, table.sourceRowNumber),
    index("tga_shortage_observations_authority_run_idx").on(table.authorityRunId),
    index("tga_shortage_observations_episode_idx").on(table.episodeKey),
    index("tga_shortage_observations_status_idx").on(table.shortageStatus),
  ],
);

export const tgaShortageMatchesTable = pgTable(
  "tga_shortage_matches",
  {
    id: serial("id").primaryKey(),
    observationId: integer("observation_id").notNull().references(() => tgaShortageObservationsTable.id),
    watchedDrugId: integer("watched_drug_id").notNull().references(() => drugsTable.id),
    watchlistEntryId: integer("watchlist_entry_id").references(() => pbsWatchlistTable.id),
    matchPaths: jsonb("match_paths").$type<string[]>().notNull().default([]),
    confidence: text("confidence").notNull(),
    matcherVersion: text("matcher_version").notNull(),
    authorityRunId: integer("authority_run_id").notNull().references(() => ingestionRunsTable.id),
    diagnosticReason: text("diagnostic_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tga_shortage_matches_observation_drug_idx").on(table.observationId, table.watchedDrugId),
    index("tga_shortage_matches_drug_confidence_idx").on(table.watchedDrugId, table.confidence),
    index("tga_shortage_matches_authority_run_idx").on(table.authorityRunId),
  ],
);

export const insertTgaShortageObservationSchema = createInsertSchema(tgaShortageObservationsTable).omit({ id: true });
export type InsertTgaShortageObservation = z.infer<typeof insertTgaShortageObservationSchema>;
export type TgaShortageObservation = typeof tgaShortageObservationsTable.$inferSelect;

export const insertTgaShortageMatchSchema = createInsertSchema(tgaShortageMatchesTable).omit({ id: true });
export type InsertTgaShortageMatch = z.infer<typeof insertTgaShortageMatchSchema>;
export type TgaShortageMatch = typeof tgaShortageMatchesTable.$inferSelect;