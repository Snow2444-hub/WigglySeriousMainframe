---
name: Schedule change completeness
description: Completeness policy for PBS schedule-change detection
---

Schedule-change detection must only run after a PBS ingestion has covered its configured page budget without exhausting the cap.

**Why:** A capped run is a partial snapshot. Treating omitted rows as delistings or new brands creates permanent false alerts because event writes are intentionally idempotent.

**How to apply:** Keep page-cap detection alongside current and historical ingestion completion, and skip comparison when the cap is reached. Authoritative schedule-wide staging must also be scoped to its ingestion run so an interrupted page cannot be promoted by a later run.

Development staging can also contain request-filtered item pages even when no page cap was reached, so deletion comparisons require provenance that proves schedule-wide coverage, not only a successful run.

**Why:** The available staged history includes drug-filtered requests and produced no trustworthy deleted-item evidence across the last twelve months.

**How to apply:** Treat schedule-wide coverage as a prerequisite for authoritative delisted alerts; keep filtered or exploratory staging useful for parsing but out of deletion comparisons.

Schedule-wide item coverage is not sufficient provenance by itself: a request key can contain an arbitrary schedule code, and its effective date may be recovered from unrelated or incomplete schedule metadata. Snapshot promotion must also validate canonical schedule identity and trusted metadata provenance.

**Why:** A leaked database-backed test fixture had complete schedule-wide item coverage, so an untrusted far-future fixture snapshot was compared with real schedules and emitted false delistings.

**How to apply:** Require a valid four-digit PBS schedule code and a matching trusted schedule metadata record before including a staged snapshot in change detection; do not let filtered or cross-run fixture metadata establish a snapshot’s date.

A page that consumes the cap can still complete its endpoint snapshot when the PBS response has no successor page. The overall run remains incomplete and must skip schedule-change comparison, but terminal endpoint snapshots should retain their complete coverage marker.

**Why:** A capped live run exposed that returning before inspecting pagination incorrectly labeled a naturally terminal dispensing-rule snapshot as incomplete.

**How to apply:** Inspect pagination before enforcing the global cap; only leave coverage incomplete when the response actually advertises another page.

Current master-item presence is not evidence that a PBS benefit remains listed; lifecycle checks must use complete schedule snapshots.

**Why:** Items can remain in the additive master table after disappearing from every later authoritative schedule, allowing predictions to coexist with genuine historical delistings.

**How to apply:** Before classifying a delisting as spurious or relisted, reconstruct item presence across complete, canonically identified snapshots. Prediction eligibility must not rely on the master table alone.