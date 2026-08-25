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
  const validIds = [...new Set(itemIds)].filter((itemId) => /^[A-Za-z0-9_-]{1,214}$/.test(itemId));
  const filters: PbsRequestFilter[] = [];

  for (let start = 0; start < validIds.length; start += 50) {
    const ids = validIds.slice(start, start + 50);
    filters.push({
      requestKey: `atc-items:${start / 50 + 1}`,
      endpoint: "items",
      params: {
        filter: ids.map((itemId) => `li_item_id eq '${itemId}'`).join(" or "),
      },
    });
  }

  return filters;
}