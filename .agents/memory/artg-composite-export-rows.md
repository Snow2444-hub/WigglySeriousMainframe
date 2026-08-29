---
name: ARTG composite export rows
description: TGA ARTG exports can include composite-pack records with blank ingredients and a populated applied-filter footer.
---

Composite-pack ARTG records may have a legitimately blank active ingredient because the ingredient is represented on component rows. Treat those rows as deliberate non-imported skips rather than invalid records. Ignore footer or summary rows that do not have the shape of a numeric ARTG record.

**Why:** TGA export rows for components such as solvents, placebo tablets, or adjuvant systems can carry the ARTG identity and product metadata without an active ingredient in that row; the export also appends an `Applied filters:` summary as a pseudo-row.

**How to apply:** Detect composite packs before required-ingredient validation and log them separately from unmatched ingredients. Detect non-record summary rows before validation. Match nonblank ARTG ingredients to tracked active ingredients by normalized whole-word containment, and convert Excel serial dates to `YYYY-MM-DD` before writing PostgreSQL `date` columns.