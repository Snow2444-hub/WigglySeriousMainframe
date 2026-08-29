import assert from "node:assert/strict";
import test from "node:test";
import { buildPageUrl } from "./pbs-ingestion";
import { buildPbsItemIdRequestFilters } from "./pbs-filtering";

test("chunks ATC item follow-up filters into gateway-safe batches", () => {
  const itemIds = Array.from(
    { length: 51 },
    (_, index) => `${10_000 + index}A_13026_29090_29103_29105`,
  );
  const filters = buildPbsItemIdRequestFilters(itemIds);

  assert.equal(filters.length, 3);
  assert.deepEqual(
    filters.map((filter) => filter.requestKey),
    ["atc-items:1", "atc-items:2", "atc-items:3"],
  );

  for (const filter of filters) {
    const expression = filter.params.filter;
    assert.ok(expression);
    assert.ok((expression.match(/li_item_id eq '/g) ?? []).length <= 25);

    const url = buildPageUrl(
      filter.endpoint ?? "items",
      1,
      100_000,
      filter.params,
      true,
    ).toString();
    assert.ok(url.length <= 2_048, `PBS item filter URL is ${url.length} characters`);
  }
});