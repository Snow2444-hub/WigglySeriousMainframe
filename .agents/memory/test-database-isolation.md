---
name: Test database isolation
description: Rules for keeping API integration tests away from the shared development database.
---

API integration tests must run against a dedicated database or a per-run schema; the shared development schema is never an acceptable test target.

**Why:** Endpoint fixtures use production-shaped rows and must exercise the real production readers, while failed tests must not leave rows that live readers can observe.

**How to apply:** Require an explicit isolated-run marker in the database package. When using a per-run schema, clone the current public schema definition with pg_dump/psql because Drizzle Kit does not honor a URL search_path for custom-schema provisioning. Verify current_schema and sentinel tables before starting tests, and always drop the schema afterward.