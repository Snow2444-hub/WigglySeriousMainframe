---
name: PBS ATC relationship ingestion
description: Documents PBS v3 ATC lookup behavior and safe handling of empty matching pages.
---

ATC codes are not filterable on the PBS `/items` endpoint. Query `/item-atc-relationships` with the documented OData `filter=atc_code eq 'VALUE'`, then use its `li_item_id` values to fetch the related `/items` records.

**Why:** The PBS OpenAPI assigns `atc_code` to the relationship endpoint. A direct `/items` ATC filter produces a 400 response. Valid exact hierarchy-level queries may return HTTP 204, which represents an empty page rather than an error.

**How to apply:** Keep ATC watchlist ingestion two-stage, preserve the global 20-second request spacing across both stages, and normalize 204 responses to an empty `data` array before staging or mapping.