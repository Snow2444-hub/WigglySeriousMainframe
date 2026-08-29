---
name: Ingestion test isolation
description: Durable rules for database-backed ingestion integration tests in a shared development database.
---

Database-backed ingestion tests must not assume that `ingestion_runs`, raw staging, or schedule-change tables are empty. Use unique fixture identifiers, scope snapshot reads and assertions to those identifiers, and serialize tests that exercise the global active-run lock.

**Why:** The development database can contain a live or interrupted ingestion and historical staged data. Parallel or global assertions then produce false failures, hide real regressions, and can make snapshot comparison tests excessively expensive.

**How to apply:** Keep production behavior global by default. Add explicit test-only scopes or exclusions to the exercised APIs, use fixture-specific schedule codes/run IDs in queries, and run the API integration suite with one test file at a time.