---
name: PBS item pricing
description: PBS /items price-field availability and the local storage rule.
---

Treat DPMQ as unavailable when ingesting PBS `/items` records. Store the endpoint's `determined_price`, `claimed_price`, and `proportional_price`; use `determined_price` for the available AEMP-equivalent field and leave DPMQ null rather than deriving it.

**Why:** The `/items` response used by filtered ingestion returns the three price fields above but has no DPMQ field. Requiring DPMQ caused valid records to be skipped.

**How to apply:** Any mapper consuming `/items` must accept a missing DPMQ. If a future source provides a documented DPMQ, populate it directly rather than calculating it from the available prices.