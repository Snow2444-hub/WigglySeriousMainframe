---
name: Ingestion test isolation
description: Durable rules for database-backed ingestion integration tests in a shared development database.
---

Database-backed ingestion tests must not assume that `ingestion_runs`, raw staging, or schedule-change tables are empty. Use unique fixture identifiers, scope snapshot reads and assertions to those identifiers, and serialize tests that exercise the global active-run lock.

Shared staging must also be treated as untrusted at production read and pruning boundaries. Fixture cleanup and scoped test reads do not neutralize rows leaked by an older test run; only staged snapshots with valid ingestion-run provenance should become authoritative or receive newest-snapshot pruning protection.

**Why:** The development database can contain a live or interrupted ingestion and historical staged data. A leaked complete fixture with a future effective date can otherwise be selected as the newest schedule, manufacture delistings, and then be preserved indefinitely by pruning.

**How to apply:** Add explicit test-only scopes or exclusions to exercised APIs, use fixture-specific schedule codes/run IDs, and serialize the API integration suite. Independently validate staged run provenance in production loaders and pruners; do not rely on teardown alone.