import assert from "node:assert/strict";
import test from "node:test";
import {
  compareScheduleSnapshots,
  type PriceChangeThresholds,
  type ScheduleSnapshot,
  type SnapshotItem,
} from "./schedule-changes";

const thresholds: PriceChangeThresholds = {
  mediumReductionPercentage: 10,
  highReductionPercentage: 20,
  firstNewBrandHighSignificance: true,
  firstNewBrandReductionPercentage: 25,
};

function item(
  overrides: Partial<SnapshotItem> = {},
): SnapshotItem {
  return {
    liItemId: "item-1",
    pbsCode: "1000A",
    drugKey: "example",
    brandName: "Example",
    strength: "10 mg",
    determinedPrice: 10,
    formulary: "F1",
    listingFields: {
      benefit_type: "U",
      maximum_quantity: 30,
      maximum_prescribable_packs: 1,
      number_of_repeats: 5,
      pack_size: 30,
      restriction_indicators: { note_indicator: "N" },
      caution_indicators: { caution_indicator: "N" },
    },
    premiumRules: [],
    ...overrides,
  };
}

function snapshot(
  drugs: Map<string, Map<string, SnapshotItem>>,
  scheduleCode: number,
  effectiveDate: string,
): ScheduleSnapshot {
  return { scheduleCode, effectiveDate, drugs };
}

test("detects all dispensing-relevant listing amendments in one record", () => {
  const previousItem = item();
  const currentItem = item({
    listingFields: {
      benefit_type: "A",
      maximum_quantity: 60,
      maximum_prescribable_packs: 2,
      number_of_repeats: 1,
      pack_size: 60,
      restriction_indicators: { note_indicator: "Y" },
      caution_indicators: { caution_indicator: "Y" },
    },
  });
  const changes = compareScheduleSnapshots(
    snapshot(new Map([["example", new Map([[previousItem.liItemId, previousItem]])]]), 1, "2026-01-01"),
    snapshot(new Map([["example", new Map([[currentItem.liItemId, currentItem]])]]), 2, "2026-02-01"),
    new Map([["example", 42]]),
    thresholds,
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, "listing_amendment");
  assert.deepEqual((changes[0].newValue as { changed_fields: string[] }).changed_fields, [
    "benefit_type",
    "maximum_quantity",
    "maximum_prescribable_packs",
    "number_of_repeats",
    "pack_size",
    "restriction_indicators",
    "caution_indicators",
  ]);
  assert.match(changes[0].notes ?? "", /benefit type changed from unrestricted to authority/);
  assert.match(changes[0].notes ?? "", /maximum prescribable packs changed from 1 to 2/);
  assert.match(changes[0].notes ?? "", /caution indicators changed/);
});

test("detects a delisted item when its entire drug disappears from the next schedule", () => {
  const previousItem = item();
  const changes = compareScheduleSnapshots(
    snapshot(new Map([["example", new Map([[previousItem.liItemId, previousItem]])]]), 1, "2026-01-01"),
    snapshot(new Map(), 2, "2026-02-01"),
    new Map([["example", 42]]),
    thresholds,
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, "delisted");
  assert.equal(changes[0].liItemId, previousItem.liItemId);
  assert.equal(changes[0].newValue, null);
});

test("detects a delisted item when the drug remains but the item disappears", () => {
  const previousItem = item();
  const remainingItem = item({ liItemId: "item-2", pbsCode: "1000B" });
  const changes = compareScheduleSnapshots(
    snapshot(new Map([["example", new Map([[previousItem.liItemId, previousItem]])]]), 1, "2026-01-01"),
    snapshot(new Map([["example", new Map([[remainingItem.liItemId, remainingItem]])]]), 2, "2026-02-01"),
    new Map([["example", 42]]),
    thresholds,
  );

  const delisted = changes.find((change) => change.changeType === "delisted");
  assert.ok(delisted);
  assert.equal(delisted.liItemId, previousItem.liItemId);
});