import assert from "node:assert/strict";
import { test } from "node:test";
import { adminAccessForRole } from "./admin-access";

test("regular users cannot access the Data updates page or see its navigation link", () => {
  const access = adminAccessForRole("user");
  assert.equal(access.canViewPage, false);
  assert.equal(access.showNavigationLink, false);
});

test("admin users can access the Data updates page and see its navigation link", () => {
  const access = adminAccessForRole("admin");
  assert.equal(access.canViewPage, true);
  assert.equal(access.showNavigationLink, true);
});

test("unknown role state fails closed for both Data updates surfaces", () => {
  const access = adminAccessForRole(undefined);
  assert.equal(access.canViewPage, false);
  assert.equal(access.showNavigationLink, false);
});