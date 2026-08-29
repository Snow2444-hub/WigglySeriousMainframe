---
name: Dashboard boundary fixtures
description: How to keep authenticated dashboard aggregation tests stable in a shared development database.
---

Dashboard aggregation fixtures should seed a uniquely identified completed snapshot, capture the dashboard baseline, then assert only the fixture’s count deltas across each period.

**Why:** The development database can contain unrelated PBS changes, predictions, and ARTG records, so absolute dashboard totals are not stable even when the fixture behavior is correct.

**How to apply:** Keep the fixture’s schedule code, dates, and item identifiers unique; verify hidden-brand and ARTG matching behavior through the delta counts and filtered detail endpoints.