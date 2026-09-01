---
name: Authority RLS execution role
description: How forced RLS remains effective across Replit managed PostgreSQL owner-role changes.
---

Application database sessions must assume the non-superuser, non-bypass `pbs_app` role before running queries; the protected authority tables are owned by that role and use `FORCE ROW LEVEL SECURITY`.

Authority setup must not hardcode the managed login name or reassert superuser-only role attributes with `ALTER ROLE`. Create `pbs_app` securely when absent; when present, validate its attributes and fail explicitly if unsafe. Use the connected owner for default privileges. On managed PostgreSQL, grant the owner membership in `pbs_app`, grant `pbs_app` temporary schema `CREATE` for ownership transfer, then revoke `CREATE`.

**Why:** Managed database migrations can replace a legacy `postgres`/superuser session with `neondb_owner`. That owner can create roles but cannot alter superuser attributes, and PostgreSQL requires role membership plus schema `CREATE` during table ownership transfer.

**How to apply:** Keep application pools role-scoped, make authority setup idempotent across managed owner names, reproduce temporary schema permissions in isolated tests, and verify raw SQL as `pbs_app` cannot see test-scoped root, master, or derived rows. Never bypass `pbs_app` as a startup fallback.