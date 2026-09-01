---
name: Authority RLS execution role
description: How forced RLS works on the shared external Neon database and how to avoid confusing it with Replit's unused managed production database.
---

Application database sessions must assume the non-superuser, non-bypass `pbs_app` role before running queries; the protected authority tables are owned by that role and use `FORCE ROW LEVEL SECURITY`.

Authority setup must not hardcode the managed login name or reassert superuser-only role attributes with `ALTER ROLE`. Create `pbs_app` securely when absent; when present, validate its attributes and fail explicitly if unsafe. Use the connected owner for default privileges. On managed PostgreSQL, grant the owner membership in `pbs_app`, grant `pbs_app` temporary schema `CREATE` for ownership transfer, then revoke `CREATE`.

**Why:** The app uses an external Neon `DATABASE_URL` secret shared by development and deployment. Replit's Database tool warns that managed production options are unavailable; its separate Production target is not the app's database. The Neon owner is `neondb_owner`, which can create roles but cannot alter superuser attributes, and PostgreSQL requires role membership plus schema `CREATE` during ownership transfer.

**How to apply:** Treat the workspace connection as the real shared external database unless the secret scope changes. Do not use Replit's managed Production database status to diagnose the deployed app. Keep pools role-scoped, make setup idempotent, and verify raw SQL as `pbs_app` cannot see test-scoped rows. Never bypass `pbs_app`.