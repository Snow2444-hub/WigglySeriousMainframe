import { createInsertSchema } from "drizzle-zod";
import { date, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const pbsSourceRegistryTable = pgTable(
  "pbs_source_registry",
  {
    sourceKey: text("source_key").primaryKey(),
    label: text("label").notNull(),
    sourceFamily: text("source_family").notNull(),
    pageUrl: text("page_url").notNull(),
    cadenceType: text("cadence_type").notNull(),
    cadenceMonth: integer("cadence_month"),
    cadenceDay: integer("cadence_day"),
    cadenceTimeZone: text("cadence_time_zone").notNull().default("Australia/Sydney"),
    cadenceConfig: jsonb("cadence_config").$type<Record<string, unknown> | null>(),
    staleAfterDays: integer("stale_after_days").notNull().default(14),
    latestAttemptFileId: integer("latest_attempt_file_id"),
    latestAttemptAt: timestamp("latest_attempt_at", { withTimezone: true, mode: "date" }),
    lastSuccessfulFileId: integer("last_successful_file_id"),
    lastSuccessfulFetchAt: timestamp("last_successful_fetch_at", { withTimezone: true, mode: "date" }),
    lastSuccessfulParseAt: timestamp("last_successful_parse_at", { withTimezone: true, mode: "date" }),
    lastSuccessfulPublicationDate: date("last_successful_publication_date", { mode: "string" }),
    nextExpectedRefreshDate: date("next_expected_refresh_date", { mode: "string" }),
    staleAfterDate: date("stale_after_date", { mode: "string" }),
    status: text("status").notNull().default("failed"),
    lastFailureStage: text("last_failure_stage"),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true, mode: "date" }),
    lastFailureMessage: text("last_failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("pbs_source_registry_family_key_idx").on(table.sourceFamily, table.sourceKey)],
);

export const insertPbsSourceRegistrySchema = createInsertSchema(pbsSourceRegistryTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertPbsSourceRegistry = z.infer<typeof insertPbsSourceRegistrySchema>;
export type PbsSourceRegistry = typeof pbsSourceRegistryTable.$inferSelect;