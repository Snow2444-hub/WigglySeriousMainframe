---
name: Authority RLS execution role
description: How forced RLS is made effective despite Replit's managed PostgreSQL login being a bypass-capable superuser.
---

Application database sessions must assume the non-superuser, non-bypass `pbs_app` role before running queries; the protected authority tables are owned by that role and use `FORCE ROW LEVEL SECURITY`.

**Why:** The runtime-managed PostgreSQL login is a superuser with `BYPASSRLS`, which no forced policy can constrain directly. Running queries as the table-owning `pbs_app` role proves that ownership itself cannot bypass forced RLS.

**How to apply:** Keep normal application pools role-scoped, reproduce ownership/grants in isolated test schemas, and verify raw SQL as `pbs_app` cannot see test-scoped root, master, or derived rows. Authority fields are mandatory; do not restore NULL-compatible policies or reader fallbacks.