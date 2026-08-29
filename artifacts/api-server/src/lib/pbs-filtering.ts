import type { PbsWatchlistEntry } from "@workspace/db";
import { ingredientContainsWholeWord, normaliseIngredient } from "./ingredient-normalisation";
import { stringField, type JsonRecord } from "./pbs-item-mapping";
import type { PbsRequestFilter } from "./pbs-ingestion";

const DIRECT_FILTERS = new Set(["brand_name", "drug_name", "pbs_code", "formulary", "program_code"]);
const EXACT_MATCH_FIELDS: Record<string, string[]> = {
  brand_name: ["brand_name"],
  pbs_code: ["pbs_code"],
  formulary: ["formulary"],
  program_code: ["program_code"],
};

export type DirectWatchlistMatcher =
  | { kind: "exact"; field: string; keys: string[]; value: string }
  | { kind: "ingredient"; value: string };

/**
 * Builds local match predicates for the non-ATC watchlist filter types, so
 * matching can run against an already-fetched full schedule snapshot instead
 * of a server-side filtered request.
 */
export function buildDirectWatchlistMatchers(entries: PbsWatchlistEntry[]): DirectWatchlistMatcher[] {
  return entries
    .filter((entry) => entry.enabled && entry.filterType !== "atc_code")
    .map((entry) => {
      const value = entry.filterValue.trim();
      if (!value) throw new Error(`PBS watchlist entry ${entry.id} has an empty filter value`);

      if (entry.filterType === "drug_name") {
        return { kind: "ingredient", value: normaliseIngredient(value) };
      }

      const keys = EXACT_MATCH_FIELDS[entry.filterType];
      if (!keys) {
        throw new Error(`PBS watchlist entry ${entry.id} has an unsupported filter type`);
      }
      return { kind: "exact", field: entry.filterType, keys, value: value.trim().toLowerCase() };
    });
}

/**
 * Restricts the watchlist to ATC entries and builds the live relationship
 * filters for them (unchanged, still a live two-step lookup: this fetches
 * matching li_item_ids, which are then matched locally against the full
 * items snapshot rather than re-fetched by ID).
 */
export function buildAtcWatchlistFilters(entries: PbsWatchlistEntry[]): PbsRequestFilter[] {
  return buildPbsRequestFilters(entries.filter((entry) => entry.filterType === "atc_code"));
}

/**
 * True if a raw record from a full schedule snapshot page matches the
 * watchlist, either via a direct field matcher or by its li_item_id being in
 * the set resolved from an ATC relationship lookup.
 */
export function recordMatchesWatchlist(
  record: JsonRecord,
  matchers: DirectWatchlistMatcher[],
  atcItemIds: ReadonlySet<string>,
): boolean {
  const liItemId = stringField(record, "li_item_id");
  if (liItemId && atcItemIds.has(liItemId)) return true;

  for (const matcher of matchers) {
    if (matcher.kind === "exact") {
      const fieldValue = stringField(record, ...matcher.keys);
      if (fieldValue && fieldValue.trim().toLowerCase() === matcher.value) return true;
    } else {
      const ingredient = stringField(record, "active_ingredient", "li_drug_name", "drug_name");
      if (ingredient && ingredientContainsWholeWord(ingredient, matcher.value)) return true;
    }
  }
  return false;
}

export function buildPbsRequestFilters(entries: PbsWatchlistEntry[]): PbsRequestFilter[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const value = entry.filterValue.trim();
      if (!value) throw new Error(`PBS watchlist entry ${entry.id} has an empty filter value`);

      if (entry.filterType === "atc_code") {
        if (!/^[A-Za-z0-9]{1,12}$/.test(value)) {
          throw new Error(`PBS watchlist entry ${entry.id} has an invalid ATC code`);
        }
        return {
          requestKey: `atc_code:${entry.id}`,
          params: { filter: `atc_code eq '${value.toUpperCase()}'` },
          endpoint: "item-atc-relationships",
        };
      }

      if (!DIRECT_FILTERS.has(entry.filterType)) {
        throw new Error(`PBS watchlist entry ${entry.id} has an unsupported filter type`);
      }

      return {
        requestKey: `${entry.filterType}:${entry.id}`,
        params: { [entry.filterType]: value },
      };
    });
}

export function buildPbsItemIdRequestFilters(itemIds: Iterable<string>): PbsRequestFilter[] {
  return buildPbsItemRelationshipFilters(itemIds, "items", "atc-items");
}

export function buildPbsItemDispensingRuleRequestFilters(itemIds: Iterable<string>): PbsRequestFilter[] {
  const validIds = [...new Set(itemIds)].filter((itemId) => /^[A-Za-z0-9_-]{1,214}$/.test(itemId));
  const filters: PbsRequestFilter[] = [];

  // The PBS endpoint accepts a comma-separated item list, while long OData
  // "or" expressions produce a 404 for historical schedule lookups.
  for (let start = 0; start < validIds.length; start += 25) {
    const ids = validIds.slice(start, start + 25);
    filters.push({
      requestKey: `item-dispensing-rules:${start / 25 + 1}`,
      endpoint: "item-dispensing-rule-relationships",
      params: { li_item_id: ids.join(",") },
    });
  }
  return filters;
}

function buildPbsItemRelationshipFilters(
  itemIds: Iterable<string>,
  endpoint: "items" | "item-dispensing-rule-relationships",
  requestKeyPrefix: string,
): PbsRequestFilter[] {
  const validIds = [...new Set(itemIds)].filter((itemId) => /^[A-Za-z0-9_-]{1,214}$/.test(itemId));
  const filters: PbsRequestFilter[] = [];

  // Keep these OData item-id filters below the gateway's URL limit. Batches of
  // 50 can be rejected by the PBS gateway with a misleading 404.
  for (let start = 0; start < validIds.length; start += 25) {
    const ids = validIds.slice(start, start + 25);
    filters.push({
      requestKey: `${requestKeyPrefix}:${start / 25 + 1}`,
      endpoint,
      params: {
        filter: ids.map((itemId) => `li_item_id eq '${itemId}'`).join(" or "),
      },
    });
  }

  return filters;
}