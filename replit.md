# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/api-server run scheduled-ingestion` — run the uncapped current PBS ingestion job once
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- PBS ingestion also requires the `PBS_SUBSCRIPTION_KEY` secret and at least one enabled PBS watchlist entry.
- External cron services can call `POST /api/admin/run-scheduled-ingestion` with `Authorization: Bearer <PBS_SCHEDULED_INGESTION_TOKEN>`. The token is stored as the `PBS_SCHEDULED_INGESTION_TOKEN` secret.

### Scheduled PBS ingestion

The API remains an always-on autoscale service. PBS automation is a separate Replit Scheduled Deployment so it does not replace the web application.

- **Build command:** `pnpm --filter @workspace/api-server run build`
- **Run command:** `node --enable-source-maps artifacts/api-server/dist/scheduled-ingestion.mjs`
- **Recommended schedule:** 17:00 UTC on the 1st, 2nd, and 3rd of every month (`0 17 1-3 * *`). This runs at 03:00 AEST or 04:00 AEDT on local days 2, 3, and 4, catching a schedule published on the 1st without relying on one exact release day; repeated runs are idempotent when the latest schedule has not changed.
- The job creates a normal ingestion-run record, uses the enabled watchlist, fetches without a page cap, and skips if another run is active. The administrator-triggered endpoint remains available for on-demand recovery.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
