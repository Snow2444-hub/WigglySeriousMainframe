# TGA Medicine Shortages — Design

**Status:** Proposed for review; no implementation has been started.

## 1. Critical server-fetch check

Checked from the application server on 31 August 2026.

### Result

Both TGA export URLs are directly fetchable server-to-server:

- Active: `https://apps.tga.gov.au/Prod/msi/search?shortagetype=All&exportType=Excel`
- Archive: `https://apps.tga.gov.au/Prod/msi/search?shortagetype=All&exportType=CSVExportArchive`

Each returned `HTTP 200` to a plain server-side GET without a prior browser session, authentication token, Referer, or special request headers. Both downloads completed cleanly. The responses set an affinity cookie, but the cookie was not required to initiate either request. Two direct requests did not trigger rate limiting; that is not proof of a published rate-limit policy, but a single daily pull per source is operationally conservative.

### Important source quirks and parser guarantees

The build must explicitly handle all four documented format quirks:

1. **Parse as CSV regardless of content type.** Despite `exportType=Excel`, the active endpoint currently returns a UTF-8 CSV with a BOM, not an XLSX workbook. Both responses advertise `Content-Type: text/plain`; format detection must use the content and/or the `Content-Disposition` filename, never the MIME type alone.
2. **Skip the explanatory preamble.** Each file begins with prose and blank records before the real header. The parser must scan normalized records for the required header columns and must not assume the header is record 1.
3. **Tolerate the archive phantom column.** The archive currently has a 12-column header but data records contain a harmless thirteenth trailing empty field. The parser may discard that one trailing empty cell, but must reject non-empty surplus columns or other width changes.
4. **Handle the source's CSV encoding/record shape.** Decode the optional UTF-8 BOM, support CRLF line endings, and use a quoted/multiline-safe CSV parser for management text. It must not split physical lines or commas manually.

The server supplies a dated `.csv` filename through `Content-Disposition`. No `ETag` or `Last-Modified` header was observed. Freshness therefore comes from retrieval time and the report-generation preamble, with hashes used for change detection.

### Actual active-file structure

- Download size observed: 342,605 bytes
- Header record: CSV record 11
- Parsed data rows: 983
- Columns:
  - ARTG ID
  - ARTG name
  - Active ingredients
  - Dosage form
  - Quantity of active ingredients
  - Sponsor
  - Phone
  - Shortage status
  - Supply impact start date
  - Supply impact end date
  - Deletion from market
  - Shortage impact rating
  - Availability
  - Reason
  - Management action
  - Last updated
- Observed shortage statuses: `Current`, `Anticipated`, `Resolved`, `Discontinued`
- Observed availability values:
  - `Unavailable`
  - `Limited Availability`
  - `Reduction in supply until supply is exhausted`
  - `Emergency Supply Only`
  - `Available`

### Actual archive-file structure

- Download size observed: 2,176,471 bytes
- Header record: CSV record 18
- Data records observed: 9,150 after tolerating the trailing empty field
- Columns:
  - ARTG ID
  - ARTG name
  - Active ingredients
  - Dosage form
  - Quantity of active ingredients
  - Sponsor
  - Phone
  - Supply impact start date
  - Supply impact end date
  - Deletion from market
  - Shortage impact rating
  - Reason

The archive does not supply shortage status, availability, management action, or last-updated date. Archived records can be classified as resolved when they have a supply-impact end date, or discontinued when they have a deletion-from-market date, but the UI must not imply that unavailable archive fields were observed.

**Decision:** Direct automated ingestion is viable. Do not build a manual upload flow.

## 2. Product scope

The first release is display-first:

1. Pull the active and archive TGA exports automatically.
2. Preserve source observations and source health.
3. Match observations conservatively to the existing PBS watchlist.
4. Lead with shortages affecting followed medicines.
5. Make the complete TGA list browseable.
6. Do not send notifications yet.

## 3. Automated daily ingestion

### Endpoint and scheduler

Add a machine-token endpoint shaped like the existing PBS scheduled-ingestion route:

`POST /api/admin/run-tga-shortages-ingestion`

- Mount it before Clerk so its non-Clerk bearer token reaches the route.
- Reuse the existing constant-time bearer-token validation pattern, but use a dedicated shortages-ingestion secret so the PBS and TGA jobs can be revoked independently.
- Return `202 Accepted` after acquiring the single-flight lock and creating the run.
- If the same job is already active, acknowledge the existing run rather than starting a competing pull.
- Add a daily trigger to the same external cron service that invokes the monthly PBS job.
- Recommended schedule: **06:30 Australia/Sydney every day**.

The daily trigger fetches **active only**. It does not pull the full 9,150-row archive every morning. Active and archive are recorded as separate source observations and have independent health.

The archive cadence is intentionally slower:

- **Active:** daily at 06:30 Australia/Sydney; this is the operational feed and is only 983 rows in the observed export.
- **Archive:** weekly, proposed Sunday at 07:00 Australia/Sydney, plus an authenticated on-demand archive refresh for an administrator or recovery run. This avoids downloading all 9,150 rows each morning.

The endpoint should accept an explicit source scope (`active`, `archive`, or `both`) so the daily cron cannot accidentally become an archive download. A failed archive pull must not invalidate a successful active snapshot, because the active snapshot drives the operational view.

### Fetch behavior

- Direct GET with a truthful application User-Agent.
- 30-second request timeout.
- Up to two retries for timeout, connection reset, `429`, and `5xx`, with bounded exponential backoff and jitter.
- Do not retry ordinary `4xx` responses other than `429`.
- Cap response size separately for active and archive files.
- Validate that the response is CSV-like after BOM removal; do not trust `text/plain` or the URL's `Excel` label.
- Capture response status, selected safe headers, retrieval time, filename, byte count, raw SHA-256, and report-generation timestamp.
- Treat HTML, an empty body, missing required headers, or a structurally changed file as a failed observation.

### Parse contract

- Decode UTF-8 with optional BOM.
- Use an RFC-4180-capable CSV parser; never split on commas or physical lines.
- Locate the header by required normalized column names after the prose preamble.
- Parse Australian `d/M/yyyy` dates explicitly.
- Preserve the original source record and normalized typed values.
- Accept the archive's current trailing empty cell, but reject non-empty surplus columns.
- Version the parser and record the version on every attempt.
- Set bounded warning samples and aggregate rejected-row counts.
- Fail the snapshot if required columns disappear.
- Flag degraded parse health if row rejection exceeds a conservative threshold, proposed at either 10 rows or 1%, whichever is greater.

### Published-file lifecycle

Reuse the existing lifecycle semantics:

1. **Fetch attempt** is always recorded, including failures.
2. **Raw source observation** is immutable.
3. **Parse result** is tied to the exact fetched bytes and parser version.
4. **Typed shortage observations** are tied to the successful file and authority run.
5. **Current projection** advances only after a complete, healthy parse.
6. **Source registry** points to latest attempt and latest successful observation separately.

Use two new source keys:

- `tga_shortages_active`
- `tga_shortages_archive`

Group them under source family `TGA medicine shortages`. Add daily cadence for the active source and weekly cadence for the archive source to the source-registry evaluator.

The existing tables are PBS-named. Implementation should reuse their lifecycle implementation, but should not overload PBS-specific typed row columns for shortage fields. Introduce shortage-specific typed observations while linking them to the existing file-attempt record. If this feature is the trigger for generic naming, perform only additive generic extraction; do not rename existing tables as part of this feature.

### Idempotency and storage

The export has no stable shortage-report identifier. ARTG ID alone is not unique: one medicine can have multiple historical episodes. Therefore:

- Treat `(file ID, source row number)` as the immutable observation identity.
- Compute a provisional episode key from ARTG ID plus supply-impact start date, or deletion date for discontinuations.
- Never merge records solely because they share an ARTG ID.
- Store a canonical content hash that excludes the changing report-generation preamble. If the canonical data is unchanged, record the successful attempt but point to the prior canonical raw payload rather than duplicating approximately 2.5 MB of CSV every day.
- Keep all attempt metadata and typed observations immutable even when raw payload bytes are content-addressed.

## 4. Authority scope

Shortage observations are shared reference data and belong inside the authority boundary.

### Authority root

Create a normal ingestion run for each daily shortages job:

- run kind/source: TGA medicine shortages
- production execution scope: `production`
- test execution scope: the isolated test scope

That ingestion run is the authority root for every typed shortage observation and every persisted match decision produced by the run.

### Protected persistence

Add a dedicated typed table, conceptually `tga_shortage_observations`, containing:

- source file and row identity
- non-null `authority_run_id`
- source kind (`active` or `archive`)
- raw and normalized TGA fields
- provisional episode key
- parsed dates
- observed status and availability, nullable only where the archive omits them

Apply forced RLS using the same derived-row rule as predictions and schedule changes:

- production readers see only rows linked to a production authority run
- isolated tests see production plus their exact test authority
- foreign test authorities remain invisible and rejected
- no NULL authority compatibility path

Persist rows through the shared derived-authority helper. Add the table to the mechanical authority-boundary writer check. File-attempt metadata must also reference the run, but a successful file record alone must never grant authority to typed observations.

## 5. Watchlist matching

### Match objective

Matching determines ordering and labelling, not whether a TGA row is retained. Every valid TGA observation remains browseable. A poor or missing match must never cause source data to disappear.

### Candidate generation

Evaluate these paths in order:

1. **Exact tracked ARTG match — highest confidence**
   - TGA `ARTG ID` equals an existing tracked ARTG entry.
   - The tracked ARTG entry already points to a watched drug.

2. **Normalized active-ingredient match — high confidence**
   - Normalize case, Unicode, punctuation, whitespace, salt/hydrate notation, and `~`-separated combinations.
   - Match a complete ingredient component to a watched drug's normalized active ingredient.
   - Combination products may match more than one watched drug and should retain all matches.

3. **Normalized brand match — corroborating confidence**
   - Compare TGA ARTG name against normalized PBS brand names for watched drugs.
   - Require a bounded token or product-name-prefix match; never use unconstrained substring matching.
   - Brand alone is accepted for display matching only when unique to one watched drug in the current catalogue.

4. **Ingredient plus brand corroboration — highest practical confidence**
   - When ingredient and brand independently identify the same watched drug, promote confidence.

### Persisted match result

Persist match decisions separately from the source observation:

- observation ID
- watched drug ID
- optional watchlist entry ID
- match paths (`artg`, `ingredient`, `brand`)
- confidence (`exact`, `high`, `review`, `unmatched`)
- matcher version
- authority run ID
- optional diagnostic reason

This makes matching explainable, re-runnable, and reviewable without rewriting the immutable TGA observation.

### Conservative confidence rules

- `exact`: exact tracked ARTG, or ingredient and unique brand agree
- `high`: exact normalized ingredient component
- `review`: unique brand only, or a fuzzy ingredient alias that is not an exact component
- `unmatched`: no safe candidate
- Ambiguous candidates remain in the full list and do not enter the followed-medicines lead view until reviewed or resolved by stronger evidence.

No edit-distance-only match should reach the followed view. Maintain explicit, testable aliases for known naming differences rather than progressively relaxing fuzzy thresholds.

### Display treatment by confidence

All safely matched rows remain visible in the followed view; lower confidence does not silently discard a shortage. The UI distinguishes the evidence:

- **High confidence — dual corroboration:** ingredient and brand identify the same watched drug. Show a prominent `High confidence match` indicator and allow the row to lead its watched-drug group.
- **Medium confidence — ingredient-only:** show an `Ingredient match` / `Medium confidence` indicator and place it after dual-corroborated rows for the same watched drug.
- **Review confidence — unique brand-only:** show a `Brand-only match` / `Review` indicator, keep the row searchable and browseable, and place it below ingredient-backed matches.
- **Ambiguous or fuzzy-only candidates:** retain them in the full TGA list with `Unmatched` or `Needs review`; do not present them as followed-medicine matches.

The match badge, evidence paths, matcher version, and confidence must be available in the detail view. The initial notification design excludes medium, review, ambiguous, and fuzzy-only rows; the 22 dual-corroborated rows are the first candidates for a later notification reliability trial, not an immediate alerting guarantee.

### Current watchlist estimate

The development watchlist currently has nine enabled drug-name entries. Against the active export fetched on 31 August 2026, a conservative ingredient/brand/ARTG simulation produced:

- 983 total active-file rows
- 32 rows matched to a watched drug
- 28 actionable matches:
  - 6 current
  - 11 anticipated
  - 11 discontinued
- 4 resolved matches
- 22 of the 32 were corroborated by both ingredient and brand
- 10 matched by ingredient only, primarily combination products
- 0 relied on exact tracked ARTG in this snapshot

Matched watched drugs in this snapshot were ferric carboxymaltose, rivaroxaban, varenicline, adalimumab, apixaban, and rosuvastatin. No active-file row safely matched denosumab, guanfacine, or lisdexamfetamine; that is consistent with no relevant report and must not be presented as a matching failure.

**Expected quality:** precision should be high with these conservative rules; recall is initially moderate because tracked ARTG coverage is uneven and TGA salt/combination naming varies. The first release should show match-path diagnostics and measure reviewed false positives/negatives before notifications are enabled.

## 6. Source health and staleness

Create independent health entries for active and archive exports.

### Proposed state rules

- `FAILED`: latest fetch or parse attempt failed, even if an older successful snapshot exists
- `STALE`: no successful active pull within **2 calendar days** after its expected daily refresh
- `COVERAGE_GAP`: the file parsed, but one or more rows expected to match a currently watched ARTG/ingredient could not be resolved safely
- `OK`: latest attempt succeeded, parse health is healthy, and freshness is within the window

`NO_RELEVANT_ROWS` is not appropriate for the overall TGA feed because the full list is intentionally retained. A watchlist with zero matches is valid and should be reported separately as “No followed medicines are in the current feed.”

### UI behavior during failure

- Continue showing the most recent healthy snapshot.
- Put a persistent `FAILED` or `STALE` banner above the list.
- Show “Last successfully updated” with Sydney-local date and time.
- Never label old records as current without the banner.
- If there has never been a successful pull, show an unavailable state rather than an empty shortage list.

Two days fits the current date-based source-health model and tolerates one missed morning while still surfacing a time-sensitive failure quickly. A future timestamp-based health model could tighten this to 36 hours.

The archive uses its own slower health expectation: mark it stale after **14 days** without a successful weekly or on-demand refresh. Archive staleness never blocks current active shortages; it only qualifies the resolved-history view and archive source indicator.

## 7. API and view structure

### Read API

Provide a shortages endpoint with:

- mode: `followed` or `all`
- section: `current`, `anticipated`, `discontinued`, or `resolved`
- availability
- impact rating
- watched drug
- search across ingredient, ARTG name, sponsor, and ARTG ID
- pagination and deterministic ordering

Every response includes:

- source as-of time
- source-health status
- last successful pull
- stale-after time/date
- result counts by section
- match confidence and paths for followed results

### Primary view: followed medicines

Add a `Medicine shortages` page whose default mode is **Following**.

Top-to-bottom structure:

1. Source-health banner when not `OK`
2. Page title and last-updated timestamp
3. Summary counts for current, anticipated, and discontinued
4. Three section tabs or segmented controls:
   - Current
   - Anticipated
   - Discontinued
5. Results grouped by watched drug
6. A `Recently resolved` context panel for followed medicines
7. Secondary action: `Browse all TGA shortages`

Within each result, visual priority is:

1. **Availability status** — strongest badge and first status read
2. Medicine/brand and active ingredient
3. Current, anticipated, or discontinued section
4. Impact rating
5. Expected supply/end or deletion date
6. Management action
7. Sponsor and last-updated detail
8. Match explanation in a low-emphasis expandable detail

Do not collapse multiple ARTG IDs merely because medicine names look similar.

### Secondary view: all shortages

The **All TGA shortages** mode keeps the same three default sections and controls, but lists every valid row whether matched or not. Followed matches receive a “Following” marker and sort ahead only within equivalent clinical status; they do not hide unmatched records.

Resolved is excluded from the default sections but remains:

- selectable through a `Resolved` filter
- searchable
- linkable by URL

Archive records belong in resolved/discontinued history. Where archive fields are absent, show `Not supplied in archive` rather than inventing availability or management information.

For a followed drug, a resolved shortage is not silently dropped. Show a compact **Recently resolved** panel on the Following view for the last **90 days**, outside the three active section counts. Each entry shows the medicine/brand, ARTG ID, resolved date or supply-impact end date, impact rating, and source-health/as-of context. If the active export supplies `Availability: Available`, show that as resolved context; if the record comes only from the archive, show unavailable fields as `Not supplied in archive`. Resolved records older than 90 days remain queryable through the Resolved filter and search.

### Default ordering

Within each section:

1. availability severity
2. TGA impact rating
3. followed match before unmatched in all-mode
4. nearest relevant date
5. medicine name

Recommended availability severity:

1. Emergency Supply Only
2. Unavailable
3. Limited Availability
4. Reduction in supply until supply is exhausted
5. Available

### Attribution

Place attribution in the page footer and source-detail panel:

> Source: Therapeutic Goods Administration, Medicine Shortage Reports Database. © Commonwealth of Australia.

Link to the TGA medicine-shortages hub and preserve the source disclaimer with the stored observation. Do not imply TGA endorsement of the application.

## 8. Notifications — deferred design only

Do not build notification delivery in the first release.

### Event model for a later phase

Compare consecutive healthy active snapshots and derive:

- newly reported shortage for a followed medicine
- status changed, such as anticipated to current
- availability worsened
- impact rating increased
- expected supply date moved later
- newly resolved
- newly discontinued

Potential user preferences:

- per watched drug
- event types
- minimum impact rating
- immediate or daily digest
- email and in-app channels

### Safety gate

Only `exact` matches should initially be eligible for alerts. `high` matches can become eligible after measured review demonstrates acceptable precision. `review`, ambiguous, and unmatched observations must never trigger an alert.

Before notification implementation, require:

- a representative review set of matched and unmatched observations
- measured precision and recall by match path
- stable episode/deduplication behavior across consecutive daily snapshots
- no duplicate alerts when report dates or wording change
- explicit suppression when source health is failed or stale

Alerting on a bad match is worse than no alert; display validation is therefore an intentional prerequisite, not merely deferred polish.

## 9. Acceptance criteria for implementation

1. Both direct exports can be fetched and parsed in automated tests using representative fixtures.
2. Active CSV is accepted despite its `Excel` query value and `text/plain` response.
3. Preamble records, BOM, CRLF, multiline fields, and the archive trailing empty cell are handled deliberately.
4. Fetch and parse failures create failed observations and update source health.
5. Latest healthy data remains visible with a failed/stale banner.
6. Typed shortage and match rows require valid authority runs and pass adversarial authority-isolation tests.
7. Every valid row is browseable regardless of match status.
8. Only conservative, explainable matches appear in the Following view.
9. Current, anticipated, and discontinued are the default sections; resolved remains queryable.
10. Availability is visually more prominent than section.
11. TGA/Commonwealth attribution is visible.
12. No notification is sent or delivery integration added.

## 10. Recommended implementation sequence after approval

1. Source fixtures, parser, and direct-fetch client
2. Source registry definitions and daily health evaluation
3. Authority-scoped observation and match persistence
4. Token-protected single-flight ingestion endpoint
5. External daily cron trigger
6. Matching engine plus review diagnostics
7. Read API and followed/all views
8. End-to-end source failure, staleness, matching, and authority tests
