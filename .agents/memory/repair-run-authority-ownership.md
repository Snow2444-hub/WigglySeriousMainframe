---
name: Repair-run authority ownership
description: Authority and lifecycle rules for one-off ingestion repair jobs that write derived PBS data.
---

One-off PBS repair jobs that write schedule changes or predictions must create a production-scoped authority run through the approved ingestion-run control module and pass that run ID to every derived-write sync.

**Why:** The authority boundary rejects direct protected-table imports from operational scripts, and unlinked derived writes are intentionally rejected.

**How to apply:** Keep protected ingestion-run table access inside the approved authority owner; persist the repair run as completed or failed, and keep the deliberate confirmation guard before any database work.