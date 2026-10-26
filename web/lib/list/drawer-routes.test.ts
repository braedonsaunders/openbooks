import assert from "node:assert/strict";
import test from "node:test";
import { LIST_DRAWER_ROUTES, isListDrawerHrefChange, listDrawerRoute } from "./drawer-routes";

const id = "019f0000-0000-4000-8000-000000000003";
test("native record opening and closing preserve every list filter without server navigation", () => {
  for (const route of Object.values(LIST_DRAWER_ROUTES)) {
    const base = route.path + "?q=invoice&page=3&status=posted&sort=amount";
    const selected = base + "&" + route.param + "=" + id;
    assert.equal(isListDrawerHrefChange(base, selected), true, route.path);
    assert.equal(isListDrawerHrefChange(selected, base), true, route.path);
    assert.equal(
      isListDrawerHrefChange(selected, selected + "&mode=edit&transactionTab=lines"),
      true,
    );
    assert.equal(
      isListDrawerHrefChange(selected, selected.replace("page=3", "page=4")),
      false,
      "a filter change must refresh rows",
    );
    assert.equal(
      isListDrawerHrefChange(base, base + "&" + route.param + "=new"),
      false,
      "create uses the native page loader",
    );
    assert.equal(isListDrawerHrefChange(base, base + "&" + route.param + "=invalid"), false);
    assert.equal(
      isListDrawerHrefChange("https://example.test" + base, "https://other.test" + selected),
      false,
    );
  }
  assert.equal(
    isListDrawerHrefChange("/payroll/runs", "/payroll/runs/" + id),
    false,
    "pay runs retain their full-page wizard",
  );
  assert.equal(isListDrawerHrefChange("/ap/bills", "/ar/invoices?doc=" + id), false);
  assert.equal(listDrawerRoute("__proto__"), null);
});

test("property management drawers preserve the selected workspace and unrelated query state", () => {
  const list = "/property-management?tab=properties&view=default&form=property-default";
  const property = `${list}&property=property-1`;
  const unit = `${property}&unit=unit-1`;
  const lease = `${unit}&lease=lease-1`;
  assert.equal(isListDrawerHrefChange(list, property), true);
  assert.equal(isListDrawerHrefChange(property, unit), true);
  assert.equal(isListDrawerHrefChange(unit, lease), true);
  assert.equal(isListDrawerHrefChange(lease, unit), true);
  assert.equal(isListDrawerHrefChange(property, `${list}&property=new`), true);
  assert.equal(
    isListDrawerHrefChange(list, "/property-management?tab=cam&view=default&form=property-default"),
    false,
  );
  assert.equal(isListDrawerHrefChange(list, `${list}&sort=name`), false);
});

test("benefit program selection preserves the catalog filters and shallow navigation excludes creation and other workspaces", () => {
  const base = "/hrm/benefits?view=programs&type=health&status=all";
  const id = "00000000-0000-4000-8000-000000000042";
  const selected = `${base}&program=${id}`;
  assert.equal(isListDrawerHrefChange(base, selected), true);
  assert.equal(isListDrawerHrefChange(selected, base), true);
  assert.equal(isListDrawerHrefChange(selected, `${selected}&setupTab=participants`), true);
  assert.equal(isListDrawerHrefChange(selected, `${selected}&edit=1`), true);
  assert.equal(
    isListDrawerHrefChange(
      selected,
      `/hrm/benefits?view=programs&type=reward&status=all&program=${id}`,
    ),
    false,
  );
  assert.equal(isListDrawerHrefChange(base, `${base}&program=new`), false);
  assert.equal(isListDrawerHrefChange(base, `${base}&program=invalid`), false);
  assert.equal(isListDrawerHrefChange(selected, `${selected}&award=new`), false);
});
