---
name: Legacy Replit Neon recovery
description: Ownership and recovery boundaries for Replit projects still using legacy Neon-hosted database infrastructure.
---

Projects with the legacy Replit database shape expose `DATABASE_URL` plus `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, and `PGPORT`. Replit documentation distinguishes this from the current Helium-backed database infrastructure, which does not expose the legacy PG variables or an external Neon console.

**Why:** Replit's current database documentation says legacy development databases were hosted on Neon, while production recovery and scheduled backups are managed through Replit's Database tool. A project can therefore have Neon-looking endpoints without the owner having a separate Neon login.

**How to apply:** Check the Replit Database tool first. For a production database, inspect PITR/history and scheduled backups there without restoring. For a legacy development database that lacks a Replit restore/history UI, ask Replit support to check the underlying Neon history; never assume an external Neon account or expose `DATABASE_URL`.