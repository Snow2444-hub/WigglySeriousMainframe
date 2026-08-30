import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actualAnniversaryDate,
  anniversaryRate,
  applyReferenceAempCap,
  calculateFirstNewBrandPrice,
  isFirstNewBrandEligible,
} from "./predicted-reductions";

test("anniversary rates preserve the 5-year and 10-year settings", () => {
  assert.equal(anniversaryRate(5, "2027-04-01", 5), 5);
  assert.equal(anniversaryRate(10, "2032-04-01", 5), 5);
});

test("the 15-year rate steps from 26.1 percent to 30 percent on 1 April 2027", () => {
  assert.equal(anniversaryRate(15, "2027-03-31", 26.1), 26.1);
  assert.equal(anniversaryRate(15, "2027-04-01", 26.1), 30);
});

test("section 99ACP uses the actual fifteenth anniversary date", () => {
  assert.equal(actualAnniversaryDate("2012-06-15", 15), "2027-06-15");
  assert.equal(actualAnniversaryDate("2012-02-29", 15), "2027-02-28");
});

test("anniversary reductions cannot take price below 40 percent of reference AEMP", () => {
  assert.deepEqual(applyReferenceAempCap(50, 36.95, 100), {
    price: 40,
    percentage: 20,
    capped: true,
  });
  assert.deepEqual(applyReferenceAempCap(100, 73.9, 100), {
    price: 73.9,
    percentage: 26.1,
    capped: false,
  });
});

test("first new brand applies the full up-to-25-percent reduction when no lower effective price exists", () => {
  assert.deepEqual(calculateFirstNewBrandPrice(100, 100), {
    price: 75,
    percentage: 25,
    usesEffectivePrice: false,
  });
});

test("first new brand uses the existing effective price when it limits the reduction", () => {
  assert.deepEqual(calculateFirstNewBrandPrice(100, 80), {
    price: 80,
    percentage: 20,
    usesEffectivePrice: true,
  });
});

test("first new brand eligibility begins on 1 October 2018", () => {
  assert.equal(isFirstNewBrandEligible("2018-09-30"), false);
  assert.equal(isFirstNewBrandEligible("2018-10-01"), true);
});