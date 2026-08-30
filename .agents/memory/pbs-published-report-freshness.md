---
name: PBS published report freshness
description: Provenance and expiry rules for PBS price-disclosure evidence.
---

Price-disclosure evidence must be retained as immutable source observations, with only the newest observation marked current. Predictions must validate both the current report's parse health/age and a persisted source-valid-until date at read time.

**Why:** A scheduled reconciliation can remove stale rows when it runs, but an old prediction can otherwise remain visible between runs or after a source failure.

**How to apply:** Keep confirmed evidence above indicative evidence, treat nullable WADP as a bounded indicative fallback, and never let a legacy price-disclosure prediction with no validity metadata bypass expiry filtering.