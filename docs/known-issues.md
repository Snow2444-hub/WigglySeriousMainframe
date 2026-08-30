# Known issues

These are deferred technical-debt items. They are documented here without
changing the affected production paths.

## Resolved safeguards

Fixture-leak recurrence is now guarded at both the staged-snapshot read path
and the pruner: complete schedule snapshots require a real `ingestion_runs`
record, implausibly future snapshots are rejected, and invalid pages cannot
receive newest-snapshot protection. Regression coverage is provided by
`ignores complete staged snapshots whose run does not exist`,
`ignores implausibly future complete snapshots even when their run exists`,
`accepts complete staged snapshots from a currently running ingestion run`,
`snapshot provenance rejects missing suffixes and allows every real run status`,
and `prunes invalid future snapshots without sacrificing the newest valid real snapshot`.

## Deferred

### Application role can be reset by the managed superuser session

Application queries assume the non-bypass `pbs_app` role, and forced RLS
protects against accidental raw protected-table access and table-owner bypass,
which are the bug classes this boundary addresses. Because the provider-managed
bootstrap session remains a PostgreSQL superuser, deliberately executing
`RESET ROLE` would escape the application role. Fully closing that path requires
a provider-issued non-superuser database login and is a separate provisioning
question.

### No source-run provenance on materialised tables

`pbs_items` and `schedule_changes` do not store the source ingestion-run ID.
The PBS directory, change feed, Overview counts, predictions, stock, and
exposure consumers are therefore run-blind (`reference.ts`, `stock.ts`, and
`predicted-reductions.ts`); a future schema, write-path, and consumer change
should add provenance and assert the canonical run. This is currently harmless
while complete ingestion uses canonical staged snapshots and the materialised
tables contain no newly contaminated run, but a bad or overlapping ingestion
could make the issue visible again.

### Schedule metadata selection differs from item-page selection

`loadStagedSnapshots()` in `artifacts/api-server/src/lib/schedule-changes.ts`
selects item pages by highest numeric run, but its fallback schedule effective
date map uses the last staging row encountered. This is currently harmless
while run and insert order agree and item payloads carry consistent effective
dates; it matters if metadata arrives out of order or from a different run.

### Staging pruning protects by effective date, not canonical run

`pruneRawScheduleStaging()` in
`artifacts/api-server/src/lib/ingestion-run-control.ts` protects valid complete
snapshots by the latest effective date rather than selecting one canonical run.
Invalid or future-dated pages are no longer protected, but duplicate complete
real runs for the newest date remain available and can mislead any run-blind
reader.

### Overview chooses most recently finished run

`getDashboardSummary()` in `artifacts/api-server/src/routes/stock.ts` chooses
the current run by most recent `finishedAt`, not highest run ID. This is
currently harmless while completion order follows run order and only one
complete current run exists; it matters if runs finish out of order or are
manually resumed.

### Published FNB uses a schedule-code sentinel

The published-FNB importer stores `scheduleCode: 0` as a sentinel for “no
schedule code.” The UI now translates that value to “FNB register,” but the
proper fix is to make the schedule code nullable rather than using `0`.
This remains deferred with no production-path change for now.

### ARTG import candidate set ignores watchlist enabled state

The ARTG importer currently loads all 76 rows from `drugsTable` as candidate
drugs in `artifacts/api-server/src/routes/admin.ts:458-465`, rather than
restricting candidates to enabled `pbs_watchlist` rows. This is currently
harmless because all enabled watchlist drugs are present in the catalogue, but
disabling a watchlist entry does not stop its ARTG rows being imported because
the importer never checks `enabled`. Changing this would be a stricter
behaviour change and remains deferred.

### ARTG combination with only a blank parent row

A combination product would be missed if its watched ingredient appeared only
on a blank parent/composite row and no parseable component row exposed that
ingredient in `Active Ingredients`. This edge case is not present in the
current data: AREXVY, the teduglutide packs, and ZetaVast Duo all expose
usable component rows. Keep this deferred until a real example requires a
targeted fix; do not split or rewrite the current matcher speculatively.