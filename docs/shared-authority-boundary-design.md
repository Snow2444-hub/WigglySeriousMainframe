# Shared Authority Boundary for Database-Backed Test Isolation

**Status:** Design for review  
**Scope:** The five highest-blast-radius tables identified by the isolation audit:
`predicted_reductions`, `schedule_changes`, `drugs`, `pbs_items`, and
`ingestion_runs`.

This document deliberately does not implement the boundary. It defines the
contract and the proof required before production code changes are made.

## 1. Confirmed runtime and CI isolation

The repository does not currently provide a separate test database or a
rollback harness:

- `lib/db/src/index.ts` creates its PostgreSQL pool from `DATABASE_URL` only.
- There is no `TEST_DATABASE_URL`, test schema selector, or database reset
  command.
- The API test command sets `NODE_ENV=test` and serializes tests with
  `--test-concurrency=1`, but that only prevents races inside one test
  process.
- Tests insert into the same database tables used by the application and
  generally depend on `try/finally` cleanup.
- No checked-in CI workflow proves that the database is reset between jobs.
- `scripts/post-merge.sh` installs dependencies and pushes the development
  schema; it does not reset data.

Therefore a failed local test, a second CI job using the same connection, a
running API, or an external ingestion caller can observe leaked rows. The
published-file `test:` namespace is a real protection for that feature, not a
general database policy.

## 2. Goals and non-goals

### Goals

1. Make production readers require an explicit authoritative scope.
2. Make derived rows prove lineage to an authoritative `ingestion_runs` row.
3. Ensure a test row with no production ancestor is invisible even when
   teardown never runs.
4. Apply one shared reader/writer contract rather than nine independent
   ad-hoc filters.
5. Preserve every legitimate existing production row during migration.
6. Keep existing business predicates intact: freshness, snapshot completeness,
   date windows, brand visibility, and user ownership remain separate concerns.

### Non-goals

- This is not a cleanup-only improvement.
- It does not treat `NODE_ENV=test` as sufficient isolation.
- It does not automatically delete ambiguous historical rows.
- It does not change prediction formulas, schedule-change semantics, or
  source-health rules.
- It does not make user-scoped `pharmacy_stock` or
  `pharmacy_brand_preferences` part of this first remediation wave.

## 3. Shared scope and provenance contract

### 3.1 Scope vocabulary

Use one shared database value called `authority_scope`:

- `production` — eligible for production readers.
- `test:<opaque-run-token>` — visible only to an explicitly test-scoped
  reader, never to a production reader.

The token is generated once per test process/run. It is not a user ID, source
key, or business identifier.

The production predicate must be positive:

> A row is authoritative because it has `authority_scope = 'production'` or
> because it references an `ingestion_runs` row with that scope.

It must not be written as “scope is not test” or “scope is non-null.” That
would allow unclassified rows to become visible accidentally.

### 3.2 `ingestion_runs` is the authority root

Add a non-null `authority_scope` to `ingestion_runs`. Every new run is created
through one shared run-creation path that assigns its scope:

- Production ingestion creates a `production` run.
- Test ingestion creates a `test:<token>` run.

The root row remains the source of truth for derived lineage. Existing run
state-machine rules remain unchanged: active-run locking, cancellation,
recovery, snapshot completeness, and status validation continue to apply.

The shared authoritative-run predicate should check scope and existence. It
must not add a blanket `finished_at` or `status = completed` restriction,
because current schedule-change tests and production behavior intentionally
allow some work to be consumed from a currently running but valid run. Existing
completeness/freshness predicates stay in their current readers.

### 3.3 Master tables: `drugs` and `pbs_items`

Add a non-null `authority_scope` to both master tables.

- A production PBS catalogue write uses `production`.
- A test fixture write uses the current test token.
- `pbs_items` continues to use `item_code` as its business key and
  `drug_id` as its foreign key; the scope is an additional authority
  dimension, not a replacement for those keys.

Master readers use one shared helper, conceptually:

```text
productionMasterScope(table) = table.authority_scope = 'production'
```

The helper is used by reference, mapping, stock joins, prediction input
loading, admin views, and any future global catalogue reader.

### 3.4 Derived tables: `predicted_reductions` and `schedule_changes`

Add a non-null `authority_run_id` to both tables, referencing
`ingestion_runs.id`.

The production-reader rule is:

```text
derived.authority_run_id -> ingestion_runs.id
AND ingestion_runs.authority_scope = 'production'
```

This is the important distinction from a free-standing `authority_scope`
column: a derived row must point to a real authority root. A test row that has
no run ancestor, or points to a test-scoped run, cannot satisfy the production
predicate.

#### `predicted_reductions` lineage

The prediction writer must pass the run that supplied the authoritative input:

- schedule-derived predictions use the run that produced the accepted
  schedule snapshot;
- published-price predictions use the production run associated with the
  published-file observation;
- statutory or other recalculations use the production run/current snapshot
  selected by the calculation coordinator.

`source_file_id` and `source_row_number` remain evidence metadata. They are
not sufficient authority by themselves because `source_file_id` is nullable.

#### `schedule_changes` lineage

Schedule comparison writes receive the run whose accepted snapshot produced
the change. Published first-new-brand processing must also provide a
production-scoped run ancestor; if the published file has no valid production
run, the code must not create an apparently authoritative schedule change.
That case should be reported for reprocessing rather than silently written
without provenance.

The existing unique indexes and new-brand reconciliation behavior remain
unchanged.

### 3.5 Shared access API

The implementation should expose shared predicates/helpers from one database
authority module, rather than repeating literal comparisons in each query.
The conceptual API is:

- `productionMasterScope(column)`
- `productionAuthorityRun(column)`
- `testAuthorityScope()`
- `createScopedIngestionRun(...)`
- `insertScopedMaster(...)` / equivalent persistence boundary
- `assertAuthoritativeRun(...)` for derived writers

The exact TypeScript names can follow repository conventions. The important
properties are:

1. New production readers have one obvious helper to use.
2. The helper positively requires production authority.
3. Derived writes cannot omit the run ancestor.
4. Tests cannot accidentally default a direct insert to production authority.

The test DB client/session should automatically establish the process test
scope. Production-facing fixture tests must not rely on an omitted nullable
column or on cleanup to provide authority.

## 4. Critical risk: proving real rows are not hidden

The shared predicate is dangerous if it is applied without a complete
backfill. The implementation must be staged so that no reader switches to the
new predicate until the existing rows have been classified and measured.

### 4.1 Baseline before changing readers

Capture, for each five-table reader:

- row counts and stable IDs for real existing rows;
- the latest successful production run and its schedule metadata;
- dashboard/reference response fixtures for known real drugs/items;
- current prediction and schedule-change results for those fixtures;
- current admin ingestion-run status and active-run behavior.

The baseline must be stored as test assertions or a reviewable migration
report, not only as an agent observation.

### 4.2 Real-row visibility matrix

For every production row selected in the baseline:

1. Backfill it to `production` authority.
2. Query the same production reader.
3. Assert the row remains present with the same user-visible fields.
4. Assert unrelated existing rows and counts do not disappear.

For derived rows, also assert that the assigned `authority_run_id` exists and
is production-scoped.

### 4.3 Failure-before-teardown matrix

Each high-priority table gets a test that follows this sequence:

1. Insert a deliberately conflicting `test:<token>` row.
2. Make the row attractive to the reader: future date, high significance,
   high priority, or conflicting price as appropriate.
3. Throw before the test's cleanup block would run.
4. Invoke the production reader or endpoint while the row still exists.
5. Assert that the response is identical to the production baseline.
6. Clean up only after the invisibility assertion.

Specific adversarial cases:

- `predicted_reductions`: test prediction with the same item/date and a
  misleadingly low price.
- `schedule_changes`: test high-significance change for an existing drug/item.
- `drugs`: test drug with a colliding search term or otherwise attractive
  reference metadata.
- `pbs_items`: test item with a colliding item/brand relationship that would
  alter catalogue, stock, or prediction joins.
- `ingestion_runs`: test completed/current run with a newer effective date or
  active status that would win latest-run or concurrency selection.

### 4.4 Existing endpoint tests that must remain green

The current endpoint/integration coverage to preserve includes:

- `artifacts/api-server/src/routes/stock.test.ts`
  - dashboard price-reduction behavior;
  - complete-run dashboard boundary;
  - authenticated dashboard counts across schedule boundaries;
  - stock exposure selecting the correct prediction.
- `artifacts/api-server/src/lib/schedule-changes.test.ts`
  - accepted and rejected staged-snapshot provenance;
  - delisted-item detection;
  - incomplete, interrupted, duplicate, future, and missing-run cases.
- `artifacts/api-server/src/lib/ingestion-run-control.test.ts`
  - invalid future snapshot pruning while retaining the newest valid real
    snapshot.
- `artifacts/api-server/src/lib/pbs-ingestion-executors.test.ts`
  - current and backfill writes, snapshots, and catalogue upserts.
- `artifacts/api-server/src/lib/ingestion-regressions.test.ts`
  - prediction generation, item backfill behavior, and price-history
    invariants.
- `artifacts/api-server/src/lib/pbs-published-files.test.ts`
  - published evidence matching and prediction effects.

Before the new boundary is enabled for a reader, these tests need a shared
fixture strategy:

- rows intentionally representing an authoritative production baseline must
  receive a valid production authority;
- rows intended to model leaked test data must receive the test scope or a
  test-scoped run;
- no endpoint test may rely on an unscoped direct insert being treated as
  production.

If the shared development database cannot safely support this distinction for
endpoint tests, the implementation must first add a per-run test schema or
database selector. That is a test-runtime boundary, not a substitute for the
production provenance predicate.

## 5. Migration and backfill

There are currently no checked-in SQL migration files; the project uses
Drizzle schema source and `drizzle-kit push`. The migration must therefore be
treated as an explicit, reviewable rollout rather than an implicit nullable
column change.

### Phase A: preflight and classification

1. Inventory all rows in the five tables and their foreign-key dependents.
2. Identify known test rows from existing namespaces, generated fixture
   patterns, failed-run records, and the historical incident.
3. Produce counts of:
   - confidently production rows;
   - confidently test rows;
   - ambiguous rows requiring review.
4. Do not delete ambiguous rows automatically.

### Phase B: additive schema

Add nullable columns first:

- `ingestion_runs.authority_scope`
- `drugs.authority_scope`
- `pbs_items.authority_scope`
- `predicted_reductions.authority_run_id`
- `schedule_changes.authority_run_id`

Add foreign-key and lookup indexes, but defer `NOT NULL` enforcement until
backfill verification completes.

### Phase C: preserve existing production data

For rows with unambiguous historical lineage, assign the matching existing
production run.

For legitimate historical rows whose original run cannot be reconstructed,
create one explicit, auditable production-scoped migration authority root
(`legacy_backfill`) and assign those rows to it. This preserves visibility
without pretending the original run ID is known.

Known leaked test rows must not be promoted by the blanket backfill. They
should be assigned a test scope or quarantined for removal after the
preflight report. Ambiguous rows remain visible only under the existing
legacy path until reviewed; the migration must not silently hide them.

### Phase D: dual-write and verify

1. Update all production writers to supply scope/run provenance.
2. Update shared readers to use the new helpers behind a verification flag or
   equivalent controlled rollout.
3. Compare baseline and post-boundary real-row responses.
4. Run failure-before-teardown tests for all five tables.
5. Run the complete serialized API suite.

### Phase E: enforce

After every existing row has valid authority:

- make scope and derived run lineage non-null;
- enforce foreign keys and appropriate check constraints;
- remove legacy reader fallbacks;
- document the persistence helper as mandatory for new global/derived writes.

## 6. Sequencing

The behavior rollout follows blast radius, while the schema work necessarily
creates the authority root first:

### 0. Authority-root groundwork

Add the root scope model and migration/backfill scaffolding without changing
user-visible readers. Establish the test token/session mechanism and baseline
measurements.

### 1. `predicted_reductions` and `schedule_changes`

These are first because a leak becomes wrong user-visible prediction or feed
data. Add derived lineage, update writers, switch readers to the shared
production-authority helper, and land failure-before-teardown tests before
moving on.

### 2. `drugs` and `pbs_items`

Add explicit master scope, update mapping/fixture persistence, and switch
reference, stock, mapping, admin, and calculation readers to the shared master
predicate. Verify that real catalogue rows remain visible.

### 3. `ingestion_runs`

Complete root-reader enforcement for admin, scheduler, recovery, dashboard
freshness, and active-run decisions. Test rows must not be able to become the
latest run or an active-run blocker.

### 4. Wider audit follow-through

Only after the five-table pattern is stable should the same contract be
considered for `raw_schedule_staging`, `price_history`, `artg_entries`,
`pbs_watchlist`, and `users`. They are not part of this first build.

## 7. Acceptance criteria for the build

The implementation is ready only when all of the following are true:

- The test and runtime isolation behavior is explicit in code and test
  configuration.
- Production readers use shared authority helpers, not duplicated literals.
- Every new prediction and schedule-change row has a real run ancestor.
- Test rows with no production ancestor remain invisible after forced cleanup
  failure.
- Existing real rows and endpoint responses remain present after backfill.
- The complete API suite, typecheck, and build pass.
- A reviewable migration report accounts for production, test, and ambiguous
  pre-existing rows.
- No unrelated table is “fixed” merely because it appeared in the audit.