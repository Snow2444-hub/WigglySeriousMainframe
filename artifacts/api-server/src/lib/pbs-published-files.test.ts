import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as XLSX from "xlsx";
import { desc, eq, inArray } from "drizzle-orm";
import {
  anniversaryFileLinkMatches,
  ingestPublishedFiles,
  inspectAnniversaryWorkbook,
  isPublishedReportFresh,
  listLatestPublishedFiles,
  publishedFileErrorMessage,
  publishedFileParseOutcome,
  section99acpFileLinkMatches,
  sourcePriority,
} from "./pbs-published-files";
import { listPbsSourceStatuses } from "./pbs-source-status";
import {
  db,
  drugsTable,
  pbsFnbReductionsTable,
  pbsItemsTable,
  pbsPublishedFileRowsTable,
  pbsPublishedFilesTable,
  pool,
  predictedReductionsTable,
  runtimeAuthorityScope,
  scheduleChangesTable,
  ingestionRunsTable,
} from "@workspace/db";

function report(overrides: Partial<{
  status: string;
  parseHealth: string;
  retrievedAt: Date;
  reportPublicationDate: string | null;
}> = {}) {
  return {
    status: "completed",
    parseHealth: "healthy",
    retrievedAt: new Date("2026-01-01T00:00:00.000Z"),
    reportPublicationDate: "2026-01-01",
    ...overrides,
  } as Parameters<typeof isPublishedReportFresh>[0];
}

test("confirmed reports take precedence over indicative reports", () => {
  assert.equal(sourcePriority("confirmed_non_efc", "confirmed"), 2);
  assert.equal(sourcePriority("indicative_non_efc", "indicative"), 1);
  assert.equal(sourcePriority("legacy", "conditional"), 0);
});

test("published reports expire at the configured maximum age", () => {
  assert.equal(isPublishedReportFresh(report(), "2026-06-30"), true);
  assert.equal(isPublishedReportFresh(report(), "2026-07-01"), false);
  assert.equal(isPublishedReportFresh(report({ parseHealth: "rejected" }), "2026-06-30"), false);
  assert.equal(isPublishedReportFresh(report({ status: "failed" }), "2026-06-30"), false);
  assert.equal(isPublishedReportFresh(report(), "2025-12-31"), false);
});

test("parsed rows remain parse-healthy when none match the local catalogue", () => {
  assert.deepEqual(publishedFileParseOutcome(36), {
    parseHealth: "healthy",
    parseStatus: "succeeded",
    failureStage: null,
    errorMessage: null,
  });
  assert.deepEqual(publishedFileParseOutcome(0), {
    parseHealth: "rejected",
    parseStatus: "failed",
    failureStage: "parse",
    errorMessage: "Parsed workbook contained no data rows",
  });
});

test("published-file errors retain only allowlisted nested PostgreSQL details", () => {
  const postgresCause = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: "pbs_fnb_reductions_drug_moa_date_idx",
    detail: "Key (drug_id, manner_of_administration, effect_date)=(1, Injection, 2021-04-01) already exists.",
    connectionString: "postgresql://should-not-be-stored",
    password: "should-not-be-stored",
  });
  const wrapped = new Error("Failed query: insert into pbs_fnb_reductions");
  Object.assign(wrapped, { cause: postgresCause });

  const message = publishedFileErrorMessage(wrapped);

  assert.equal(
    message,
    "Failed query: insert into pbs_fnb_reductions; SQLSTATE 23505; constraint pbs_fnb_reductions_drug_moa_date_idx; detail Key (drug_id, manner_of_administration, effect_date)=(1, Injection, 2021-04-01) already exists.",
  );
  assert.equal(message.includes("postgresql://"), false);
  assert.equal(message.includes("password"), false);
});

function anniversaryWorkbook(sheets: Array<{ name: string; title: string; proposedDate: string }>) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        [sheet.title],
        [
          "F1 Legal Instrument Drug",
          "Legal Instrument Form",
          "Brand Name",
          "Responsible Person",
          "AEMP as at 1 July 2026",
          `Proposed AEMP as at ${sheet.proposedDate}`,
        ],
        ["Example drug", "Tablet 10 mg", "Example", "Example Pty Ltd", "$10.00", "$9.50"],
      ]),
      sheet.name,
    );
  }
  return { workbook, bytes: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })) };
}

test("anniversary and 99ACP links select the current Excel labels", () => {
  assert.equal(
    anniversaryFileLinkMatches({
      text: "Indicative pricing – Anniversary Price Reductions – FED – 1 April 2027.xlsx (Excel 20.7KB)",
      href: "https://www.pbs.gov.au/current.xlsx",
    }),
    true,
  );
  assert.equal(
    anniversaryFileLinkMatches({
      text: "Excel version – Five Year F1 5% Statutory Price Reduction - 1 April 2026 Indicative Pricing",
      href: "https://www.pbs.gov.au/old.xlsx",
    }),
    false,
  );
  assert.equal(
    section99acpFileLinkMatches({
      text: "Indicative pricing s. 99ACP Anniversary List for 2027.xlsx (Excel 14KB)",
      href: "https://www.pbs.gov.au/current-99acp.xlsx",
    }),
    true,
  );
  assert.equal(
    section99acpFileLinkMatches({
      text: "Indicative pricing s. 99ACP Anniversary List from 1 April 2025 onwards.xlsx",
      href: "https://www.pbs.gov.au/old-99acp.xlsx",
    }),
    false,
  );
});

test("anniversary workbook inspection handles multi-sheet 1 April lists", () => {
  const { workbook, bytes } = anniversaryWorkbook([
    {
      name: "s99ACHB Indicative list",
      title: "Five year Anniversary Price Reduction under section 99ACHB",
      proposedDate: "1 April 2027",
    },
    {
      name: "s99ACJA Indicative list",
      title: "Ten year Anniversary Price Reduction under section 99ACJA",
      proposedDate: "1 April 2027",
    },
  ]);
  const inspected = inspectAnniversaryWorkbook(workbook, bytes);
  assert.equal(inspected.publicationDate, "2026-08-01");
  assert.deepEqual(
    inspected.sheets.map((sheet) => [sheet.sheetName, sheet.rowCount, sheet.effectiveDate]),
    [
      ["s99ACHB Indicative list", 1, "2027-04-01"],
      ["s99ACJA Indicative list", 1, "2027-04-01"],
    ],
  );
  assert.deepEqual(inspected.sheets[0]?.headers.slice(0, 3), [
    "F1 Legal Instrument Drug",
    "Legal Instrument Form",
    "Brand Name",
  ]);
});

test("anniversary workbook inspection derives 99ACP publication and sheet dates", () => {
  const { workbook, bytes } = anniversaryWorkbook([
    { name: "Indicative August 2027", title: "Section 99ACP indicative pricing", proposedDate: "1 August 2027" },
    { name: "Indicative October 2027", title: "Section 99ACP indicative pricing", proposedDate: "1 October 2027" },
    { name: "Indicative December 2027", title: "Section 99ACP indicative pricing", proposedDate: "1 December 2027" },
  ]);
  const inspected = inspectAnniversaryWorkbook(workbook, bytes);
  assert.equal(inspected.publicationDate, "2026-08-01");
  assert.deepEqual(
    inspected.sheets.map((sheet) => sheet.effectiveDate),
    ["2027-08-01", "2027-10-01", "2027-12-01"],
  );
});

function responseWithUrl(body: string | Buffer, url: string, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("re-ingesting the same first-new-brand workbook updates its existing reduction", async () => {
  const token = `published_file_${process.pid}_${Date.now()}`;
  const itemCode = `${token}_ITEM`;
  const ingredient = `${token} ingredient`;
  const drugId = 1_850_000_000 + (process.pid % 100_000);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Drug", "Manner of Administration", "Date of effect"],
      [ingredient, "Injection", "2026-04-01"],
    ]),
    "First New Brand",
  );
  const workbookBytes = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const originalFetch = globalThis.fetch;
  const pageUrl = "https://www.pbs.gov.au/industry/pricing/pbs-items/first-new-brand-price-reductions";
  const fileUrl = "https://www.pbs.gov.au/industry/pricing/pbs-items/first-new-brand.xlsx";
  let authorityRunId: number | undefined;

  try {
    const [run] = await db
      .insert(ingestionRunsTable)
      .values({
        status: "completed",
        mode: "current",
        scheduleDate: "2026-01-01",
        authorityScope: runtimeAuthorityScope(),
      })
      .returning({ id: ingestionRunsTable.id });
    assert.ok(run);
    authorityRunId = run.id;
    await db.insert(drugsTable).values({
      id: drugId,
      name: ingredient,
      activeIngredient: ingredient,
      sponsor: "Published-file regression test",
      firstPbsListingDate: "2020-01-01",
      authorityScope: runtimeAuthorityScope(),
    });
    await db.insert(pbsItemsTable).values({
      itemCode,
      pbsCode: `PBS-${itemCode}`,
      liItemId: itemCode,
      scheduleCode: 990_001,
      drugId,
      brandName: `${token} brand`,
      strength: "40 mg",
      form: "Injection",
      packSize: "1",
      pricingQuantity: null,
      benefitTypeCode: "S",
      maximumQuantityUnits: 1,
      liForm: "Injection 40 mg",
      programCode: "GE",
      formulary: "F2",
      currentAemp: 100,
      currentDpmq: null,
      lastUpdated: "2026-01-01",
      firstListedDate: "2020-01-01",
      weightedAvgDisclosedPrice: null,
      originatorBrandIndicator: null,
      brandSubstitutionGroupId: null,
      advancedNoticeDate: null,
      nonEffectiveDate: null,
      determinedPrice: 100,
      claimedPrice: null,
      proportionalPrice: null,
      therapeuticGroupId: null,
      innovatorIndicator: null,
      authorityScope: runtimeAuthorityScope(),
    });

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === pageUrl) {
        return responseWithUrl(
          `<a href="${fileUrl}">First New Brand price reductions workbook</a>`,
          pageUrl,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url === fileUrl) {
        return responseWithUrl(workbookBytes, fileUrl, {
          status: 200,
          headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        });
      }
      throw new Error(`Unexpected published-file fixture request: ${url}`);
    };

    const firstReport = await ingestPublishedFiles(authorityRunId, { sourceKeys: ["first_new_brand"] });
    const firstFnb = firstReport.files.find((file) => file.sourceKey === "first_new_brand");
    assert.equal(firstFnb?.status, "completed");
    assert.equal(firstFnb?.matchedRows, 1);

    const [firstFile] = await db
      .select({ id: pbsPublishedFilesTable.id })
      .from(pbsPublishedFilesTable)
      .where(eq(pbsPublishedFilesTable.sourceKey, "test:first_new_brand"))
      .orderBy(desc(pbsPublishedFilesTable.id))
      .limit(1);
    assert.ok(firstFile);

    const secondReport = await ingestPublishedFiles(authorityRunId, { sourceKeys: ["first_new_brand"] });
    const secondFnb = secondReport.files.find((file) => file.sourceKey === "first_new_brand");
    assert.equal(secondFnb?.status, "completed");
    assert.equal(secondFnb?.matchedRows, 1);

    const [latestFile] = await db
      .select({ id: pbsPublishedFilesTable.id })
      .from(pbsPublishedFilesTable)
      .where(eq(pbsPublishedFilesTable.sourceKey, "test:first_new_brand"))
      .orderBy(desc(pbsPublishedFilesTable.id))
      .limit(1);
    assert.ok(latestFile);

    const reductions = await db
      .select({
        fileId: pbsFnbReductionsTable.fileId,
        sourceRowNumber: pbsFnbReductionsTable.sourceRowNumber,
        drugId: pbsFnbReductionsTable.drugId,
        effectDate: pbsFnbReductionsTable.effectDate,
      })
      .from(pbsFnbReductionsTable)
      .where(eq(pbsFnbReductionsTable.drugId, drugId));

    assert.notEqual(firstFile.id, latestFile.id);
    assert.deepEqual(reductions, [{
      fileId: latestFile.id,
      sourceRowNumber: 2,
      drugId,
      effectDate: "2026-04-01",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    await db.delete(predictedReductionsTable).where(eq(predictedReductionsTable.drugId, drugId));
    await db.delete(scheduleChangesTable).where(eq(scheduleChangesTable.drugId, drugId));
    await db.delete(pbsFnbReductionsTable).where(eq(pbsFnbReductionsTable.drugId, drugId));
    if (authorityRunId !== undefined) {
      const fileIds = (await db
        .select({ id: pbsPublishedFilesTable.id })
        .from(pbsPublishedFilesTable)
        .where(eq(pbsPublishedFilesTable.ingestionRunId, authorityRunId)))
        .map((file) => file.id);
      if (fileIds.length > 0) {
        await db.delete(pbsPublishedFileRowsTable).where(inArray(pbsPublishedFileRowsTable.fileId, fileIds));
        await db.delete(pbsPublishedFilesTable).where(inArray(pbsPublishedFilesTable.id, fileIds));
      }
    }
    await db.delete(pbsItemsTable).where(eq(pbsItemsTable.itemCode, itemCode));
    await db.delete(drugsTable).where(eq(drugsTable.id, drugId));
    if (authorityRunId !== undefined) {
      await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, authorityRunId));
    }
  }
});

test("an abandoned test observation is invisible to operational published-file readers", async () => {
  const canonicalFileName = "operational-first-new-brand.xlsx";
  const testFileName = "abandoned-test-first-new-brand.xlsx";
  const createdFileIds: number[] = [];
  let authorityRunId: number | undefined;

  try {
    const [run] = await db
      .insert(ingestionRunsTable)
      .values({
        status: "failed",
        mode: "current",
        scheduleDate: "2026-01-01",
        authorityScope: runtimeAuthorityScope(),
      })
      .returning({ id: ingestionRunsTable.id });
    assert.ok(run);
    authorityRunId = run.id;
    const inserted = await db
      .insert(pbsPublishedFilesTable)
      .values([
        {
          sourceKey: "first_new_brand",
          pageUrl: "https://www.pbs.gov.au/operational",
          fileUrl: "https://www.pbs.gov.au/operational.xlsx",
          fileName: canonicalFileName,
          fileSha256: `operational_${process.pid}_${Date.now()}`,
          rawContentBase64: "",
          parserVersion: "test",
          status: "completed",
          parseHealth: "healthy",
          fetchStatus: "succeeded",
          parseStatus: "succeeded",
          ingestionRunId: authorityRunId,
          totalRows: 1,
          matchedRows: 1,
          isCurrent: true,
        },
        {
          sourceKey: "test:first_new_brand",
          pageUrl: "https://example.test/abandoned",
          fileUrl: "https://example.test/abandoned.xlsx",
          fileName: testFileName,
          fileSha256: `abandoned_${process.pid}_${Date.now()}`,
          rawContentBase64: "",
          parserVersion: "test",
          status: "failed",
          parseHealth: "rejected",
          fetchStatus: "succeeded",
          parseStatus: "failed",
          failureStage: "parse",
          errorMessage: "Intentional failure before teardown",
          ingestionRunId: authorityRunId,
          isCurrent: true,
        },
      ])
      .returning({ id: pbsPublishedFilesTable.id });
    createdFileIds.push(...inserted.map((file) => file.id));

    const statuses = await listPbsSourceStatuses();
    const firstNewBrand = statuses.find((status) => status.sourceKey === "first_new_brand");
    assert.equal(firstNewBrand?.latestFileName, canonicalFileName);

    const latestFiles = await listLatestPublishedFiles();
    assert.equal(latestFiles.some((file) => file.fileName === testFileName), false);
    assert.equal(latestFiles.some((file) => file.fileName === canonicalFileName), true);
  } finally {
    if (createdFileIds.length > 0) {
      await db.delete(pbsPublishedFilesTable).where(inArray(pbsPublishedFilesTable.id, createdFileIds));
      await listPbsSourceStatuses();
    }
    if (authorityRunId !== undefined) {
      await db.delete(ingestionRunsTable).where(eq(ingestionRunsTable.id, authorityRunId));
    }
  }
});

after(async () => {
  await pool.end();
});