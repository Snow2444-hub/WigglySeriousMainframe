---
name: PBS ATC relationship ingestion
description: Documents PBS v3 ATC lookup behavior and safe handling of empty matching pages.
---

ATC codes are not filterable on the PBS `/items` endpoint. Query `/item-atc-relationships` with the documented OData `filter=atc_code eq 'VALUE'`, then use its `li_item_id` values to fetch the related `/items` records.

**Why:** The PBS OpenAPI assigns `atc_code` to the relationship endpoint. A direct `/items` ATC filter produces a 400 response. Valid exact hierarchy-level queries may return HTTP 204, which represents an empty page rather than an error.

Current-schedule ingestion should only collect item IDs from `/item-atc-relationships`. Direct `/items` watchlist responses already contain the complete item records and must not trigger a redundant `/items?filter=li_item_id...` follow-up.

**Why:** The redundant direct-item follow-up generated large OData filters that the PBS gateway rejected with a misleading 404, while ATC relationship results contain IDs but not the item records needed for mapping.

**How to apply:** Keep ATC watchlist ingestion two-stage, batch item-ID follow-ups in groups of 25, preserve the global 20-second request spacing across both stages, and normalize 204 responses to an empty `data` array before staging or mapping.