---
name: Repair-run authority ownership
description: Authority and lifecycle rules for one-off ingestion repair jobs that write derived PBS data.
---

One-off PBS repair jobs that write schedule changes, predictions, or catalogue lifecycle state must first export the exact proposed row set from a complete canonical snapshot, then apply through a production-scoped authority run created by the approved ingestion-run control module.

**Why:** The authority boundary rejects direct protected-table imports from operational scripts, and unlinked derived writes are intentionally rejected.

**How to apply:** Keep protected table access inside the approved authority owner; make report generation the default, require deliberate confirmation for mutation, pass the repair run ID to every derived-write sync, and persist the run as completed or failed.