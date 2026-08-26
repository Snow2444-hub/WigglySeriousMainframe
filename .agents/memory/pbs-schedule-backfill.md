---
name: PBS schedule backfill
description: PBS API semantics for rolling historical schedule ingestion.
---

List historical schedules with `get_latest_schedule_only=false`, select the rolling window from the latest returned `effective_date`, and process schedules oldest-to-newest. Do not infer chronology from `schedule_code`.

**Why:** Historical schedule codes are not chronologically ordered, while `effective_date` is the authoritative timeline for change detection.

**How to apply:** Add each schedule’s `schedule_code` to the watchlisted endpoint request, keep latest-only disabled for historical item fetches, and compare prices in effective-date order while preserving the shared 20-second request gap.