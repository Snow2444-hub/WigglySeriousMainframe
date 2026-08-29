---
name: Ingestion restart resume
description: Durable rules for resuming PBS ingestion after an API restart without unsafe snapshot comparisons.
---

Persist the original schedule date, ingestion mode, and page cap with every PBS run. On startup, interrupted active runs and runs explicitly marked as interrupted by a restart are requeued and resumed in a single serialized queue.

**Why:** A restart cannot safely reconstruct a backfill window or page limit from the current clock, and concurrently replaying multiple runs bypasses the ingestion guard and creates duplicate staging pressure.

Run-scoped staged pages are the resume checkpoint: replay them through the same mapping callbacks before requesting missing pages. A staged schedule-wide snapshot becomes trusted only when the crawl reaches its natural end without a page cap; incomplete, filtered, or capped coverage must remain excluded from schedule-change and delisting detection.

**How to apply:** Any new ingestion endpoint or executor must persist its deterministic configuration, use the run-scoped staging key when resumable, and preserve the complete-coverage gate before syncing schedule changes.