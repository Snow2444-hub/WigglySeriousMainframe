import type { PbsWatchlistEntry } from "@workspace/db";
import type { PbsRequestFilter } from "./pbs-ingestion";

const DIRECT_FILTERS = new Set(["brand_name", "drug_name", "pbs_code", "formulary", "program_code"]);

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

  for (let start = 0; start < validIds.length; start += 50) {
    const ids = validIds.slice(start, start + 50);
    filters.push({
      requestKey: `${requestKeyPrefix}:${start / 50 + 1}`,
      endpoint,
      params: {
        filter: ids.map((itemId) => `li_item_id eq '${itemId}'`).join(" or "),
      },
    });
  }

  return filters;
}