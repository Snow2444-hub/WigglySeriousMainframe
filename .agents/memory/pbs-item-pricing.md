---
name: PBS item pricing
description: PBS /items price-field availability and the local storage rule.
---

Treat DPMQ as unavailable when ingesting PBS `/items` records. Store the endpoint's `determined_price`, `claimed_price`, and `proportional_price`; use `determined_price` for the available AEMP-equivalent field and leave DPMQ null rather than deriving it.

**Why:** The `/items` response used by filtered ingestion returns the three price fields above but has no DPMQ field. Requiring DPMQ caused valid records to be skipped.

**How to apply:** Any mapper consuming `/items` must accept a missing DPMQ. If a future source provides a documented DPMQ, populate it directly rather than calculating it from the available prices.

Latest `/items` records include `schedule_code` but not the schedule effective date. Resolve that date from the latest `/schedules` record’s `effective_date` and store both values with price history.

The API v3 data dictionary marks `weighted_avg_disclosed_price` as a legacy Price Disclosure field that will be null in future schedules until removal. Treat a null WADP as unavailable and do not infer it from AEMP changes or other price fields.

**Why:** Real rosuvastatin records across a 13-schedule backfill all supplied null WADP, matching the official dictionary.

**How to apply:** Generate disclosure predictions only when a documented source supplies WADP. Zero predictions is the correct result when this field is null.