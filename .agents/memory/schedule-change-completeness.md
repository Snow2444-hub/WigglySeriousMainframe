---
name: Schedule change completeness
description: Completeness policy for PBS schedule-change detection
---

Schedule-change detection must only run after a PBS ingestion has covered its configured page budget without exhausting the cap.

**Why:** A capped run is a partial snapshot. Treating omitted rows as delistings or new brands creates permanent false alerts because event writes are intentionally idempotent.

**How to apply:** Keep page-cap detection alongside current and historical ingestion completion, and skip comparison when the cap is reached. Full snapshot provenance/correction support belongs in the follow-up work.