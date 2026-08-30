# PBS reduction prediction design proposals

This document records the two deferred design areas from the PBS reduction audit. They are proposals only; the current implementation does not claim to calculate either area.

## Price-disclosure hardening

### Recommended phases

1. **Source contract and provenance**
   - Add a confirmed-report source type alongside the existing indicative sources.
   - Store source URL/file identity, report publication date, source row, parser version, and the covered effective-date cycle.
   - Keep one row per source observation so a later parse can be audited instead of silently replacing evidence.
2. **Freshness and parse health**
   - Validate that a report is within a configured maximum age for its effective cycle.
   - Record fetch, parse, match, and rejection counts on the published-file record.
   - Mark a source stale or failed when the file cannot be parsed; do not leave its old predictions looking current.
3. **Bound legacy WADP use**
   - Treat nullable WADP as an optional legacy signal, never as a substitute for a confirmed report.
   - Require an explicit provenance and age check before WADP can create a prediction.
   - Bound the amount and duration of a WADP-derived prediction and label it as indicative in API and UI responses.
4. **Reconciliation and cleanup**
   - Reconcile by item, effective date, and source priority: confirmed report, then fresh indicative report, then bounded legacy WADP.
   - Remove or expire predictions whose source is stale, rejected, or no longer present after a successful parse.
   - Add fixture cases for confirmed-over-indicative precedence, stale reports, parse failure, missing WADP, and source recovery.

### Open decisions and risks

- Confirm the official report naming and publication cadence before setting a default max age.
- A source failure must be visible to operators; silently retaining the prior estimate creates more risk than showing “not available”.
- Migration will need a backfill policy for existing indicative rows, because their original source freshness may not be reconstructable.

## Combination flow-on data model

### Recommended phases

1. **Evidence model**
   - Add an explicit combination-to-component relationship with source schedule, listed status, component item code, component weight/quantity, and effective dates.
   - Store component-level AEMP observations and their provenance rather than flattening them into the combination item.
2. **Calculation model**
   - Persist a calculation run and its inputs: component AEMPs, weights, listed status, applicable rule, cap, and rounding.
   - Persist component-level predicted events and a combination-level result with a traceable explanation.
   - Version the rule and calculation input shape so rule changes never reinterpret old evidence.
3. **Controlled rollout**
   - Start with read-only candidate detection and an “insufficient evidence” state.
   - Compare calculated candidates with manually reviewed PBS examples before exposing financial outputs.
   - Add explicit UI labels distinguishing a complete calculation, a candidate, and an unmodelled relationship.
4. **Operations and governance**
   - Add reconciliation checks for missing components, duplicate relationships, weight totals, stale component prices, and listed-status conflicts.
   - Provide an audit view showing every source record used in a flow-on result.

### Why approximation is unsafe

The current schema stores one item-level AEMP and one scalar prediction. It cannot represent component weights, component-level price bases, or listed-status evidence. Any formula based on the combination item alone would produce a plausible-looking number without the inputs required to defend it, so flow-on remains intentionally uncalculated until the evidence model exists.