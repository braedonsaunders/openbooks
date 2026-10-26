import assert from "node:assert/strict";
import test from "node:test";
import { profileHidesProjectHeaderField } from "./project-header-visibility.ts";

// A shop-job profile switches its presentation flags off (showForeman:
// false), yet the foreman field must still render: it comes from the one
// shared project field set, and only an explicit form-layout omission hides
// it (which never reaches this helper).
const SHOP_JOBS = { showSite: false, showForeman: false, showCustomerPo: true };
const BUILDER_LOT = { showSite: true, showForeman: true, showCustomerPo: true };

test("foreman renders under every operating profile", () => {
  assert.equal(profileHidesProjectHeaderField("foreman_id", SHOP_JOBS), false);
  assert.equal(profileHidesProjectHeaderField("foreman_id", BUILDER_LOT), false);
  assert.equal(profileHidesProjectHeaderField("foreman_id", null), false);
  assert.equal(profileHidesProjectHeaderField("foreman_id", undefined), false);
});

test("site and customer-PO keep their profile switches", () => {
  assert.equal(profileHidesProjectHeaderField("site_jurisdiction", SHOP_JOBS), true);
  assert.equal(profileHidesProjectHeaderField("site_jurisdiction", BUILDER_LOT), false);
  assert.equal(profileHidesProjectHeaderField("customer_po_number", SHOP_JOBS), false);
  assert.equal(
    profileHidesProjectHeaderField("customer_po_number", { ...SHOP_JOBS, showCustomerPo: false }),
    true,
  );
});

test("unrelated fields are never profile-hidden", () => {
  for (const key of ["name", "customer_id", "manager_id", "starts_on"]) {
    assert.equal(profileHidesProjectHeaderField(key, SHOP_JOBS), false);
  }
});
