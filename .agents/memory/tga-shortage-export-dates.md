---
name: TGA shortage export dates
description: How to identify publication dates in TGA medicine-shortage exports without mistaking row dates for report dates.
---

TGA medicine-shortage exports use a preamble line such as `Report generated 31 August 2026`; derive source freshness from that labelled line, not the first date-shaped value in the file.

**Why:** The first numeric date elsewhere in the export may belong to a shortage episode, causing a freshly retrieved source to be marked stale.

**How to apply:** Prefer the labelled report-generated date and support named Australian month formats before considering any narrower fallback.