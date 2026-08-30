---
name: PBS anniversary workbook feeds
description: External structure and discovery rules for the PBS anniversary indicative and section 99ACP workbooks.
---

Select the current anniversary workbooks from the PBS anniversary publication page by their visible Excel link labels rather than hardcoding dated URLs. The 1 April indicative workbook contains separate sheets for the statutory sections, while the 99ACP workbook contains separate month-specific sheets. Both current-cycle files are published from 1 August of the preceding year, and each sheet's proposed AEMP header supplies its effective date.

**Why:** PBS keeps historical files on the same page and changes dated filenames each annual cycle; selecting by the current-label pattern prevents silently ingesting an old workbook.

**How to apply:** Treat each worksheet as an auditable observation partition, preserve the sheet name in row evidence, derive row effective dates from the proposed-AEMP header, and derive the publication date from the current reduction year minus one year on 1 August.