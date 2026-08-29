# Known issues

These are deferred technical-debt items. They are documented here without
changing the affected production paths.

## Deferred

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
`artifacts/api-server/src/lib/ingestion-run-control.ts` protects complete
snapshots by the latest effective date rather than selecting one canonical run.
This is currently harmless because downstream staged readers select the
highest run, but duplicate complete runs for the newest date remain available
and can mislead any run-blind reader.

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