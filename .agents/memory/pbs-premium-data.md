---
name: PBS premium data
description: Authoritative PBS API source and linkage for brand and therapeutic-group premiums.
---

PBS API v3 publishes `brand_premium` and `therapeutic_group_premium` on the `/item-dispensing-rule-relationships` endpoint. Join these records to `/items` through `li_item_id`; the related `therapeutic_exemption_indicator` determines exemptions that produce a zero premium.

**Why:** A brand premium is not safely derivable from an item's AEMP relative to a substitution group. The PBS data dictionary defines the relationship values as the patient-paid premiums.

**How to apply:** Ingest the relationship endpoint for every schedule used in a price-history comparison, attach values by `li_item_id`, and compare those authoritative values to produce premium add/change/remove events. For historical schedules, use the endpoint's comma-separated `li_item_id` parameter in batches of 25 or fewer: larger lists and long OData `or` filters can return a misleading 404 despite valid records.