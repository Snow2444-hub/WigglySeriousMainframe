---
name: PBS parent listing dates
description: How item-level PBS listing dates roll up to an active-ingredient parent drug.
---

A PBS active ingredient can have item rows with different `first_listed_date` values as strengths or packs are added. The parent drug’s first PBS listing date must be the earliest date across its items.

**Why:** Overwriting the parent date with each item made the final value depend on API record order and shifted statutory-reduction anniversaries.

**How to apply:** When resolving or refreshing a parent drug, retain the minimum of the stored parent date and every incoming item date before recalculating predictions.