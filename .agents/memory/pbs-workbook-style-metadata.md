---
name: PBS workbook style metadata
description: How to detect yellow-highlighted PBS published rows reliably with SheetJS.
---

SheetJS cell objects do not reliably retain the original XLSX style index or fill color. When row highlighting carries meaning, inspect the workbook ZIP XML: map yellow fills in `styles.xml` to cell style IDs, then map those IDs to row numbers in the first worksheet XML.

**Why:** The PBS First New Brand workbook uses yellow fills only on selected cells, and SheetJS's high-level `cell.s` representation can reduce those styles to an uninformative pattern object.

**How to apply:** Keep the normal SheetJS workbook parser for values, but use a ZIP/XML reader available alongside SheetJS for style-driven semantics; treat style parsing as optional for files that do not use highlighting.