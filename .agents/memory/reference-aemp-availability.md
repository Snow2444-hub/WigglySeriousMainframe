---
name: Reference AEMP availability
description: How to handle statutory reference-AEMP calculations when retained PBS price history does not reach the required historical date
---

When retained PBS price history does not contain an observation at or before the statutory reference date, a prediction may use the current AEMP only as an explicitly conditional display estimate; it must not present the 60% reference-AEMP cap as verified.

**Why:** The development dataset can retain only recent price-history observations, while the anniversary rule may require a 1 January 2016 or listing-date AEMP. Substituting a recent value would create a plausible but unsupported regulatory baseline.

**How to apply:** Prefer an exact historical observation and high-confidence output. If unavailable, preserve the visible event only with conditional confidence and source text that calls out the missing reference evidence; never silently infer an old AEMP.