---
name: Schedule change completeness
description: Completeness policy for PBS schedule-change detection
---

Schedule-change detection must only run after a PBS ingestion has covered its configured page budget without exhausting the cap.

**Why:** A capped run is a partial snapshot. Treating omitted rows as delistings or new brands creates permanent false alerts because event writes are intentionally idempotent.

**How to apply:** Keep page-cap detection alongside current and historical ingestion completion, and skip comparison when the cap is reached. Full snapshot provenance/correction support belongs in the follow-up work.

Development staging can also contain request-filtered item pages even when no page cap was reached, so deletion comparisons require provenance that proves schedule-wide coverage, not only a successful run.

**Why:** The available staged history includes drug-filtered requests and produced no trustworthy deleted-item evidence across the last twelve months.

**How to apply:** Treat schedule-wide coverage as a prerequisite for authoritative delisted alerts; keep filtered or exploratory staging useful for parsing but out of deletion comparisons.