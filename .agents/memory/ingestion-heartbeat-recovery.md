---
name: Ingestion heartbeat recovery
description: Safety boundary between restart recovery and silent-hang recovery for serialized ingestion runs.
---

Silent in-process ingestion hangs should be retired as failed, allowing the next scheduled acquisition to start a fresh run; only process-restart recovery should requeue and replay the same run.

**Why:** Requeueing a run while its original executor is still alive can create concurrent fetches and duplicate completion/progress writes, defeating the global ingestion lock.

**How to apply:** Persist page progress separately from start time, use it for stale detection, and keep same-run staged replay in the restart recovery path. If same-run stale resume is ever required, add an execution lease/token or terminate the original executor first.