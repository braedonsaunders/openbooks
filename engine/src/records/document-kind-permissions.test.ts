import assert from "node:assert/strict";
import test from "node:test";
import {
  documentKindPermissions,
  documentPostingPermission,
  documentRouteEditPermission,
  postPermission,
} from "./document-kind-permissions.ts";

test("posting-effect authority retains payment duties and separates payroll workflow from GL posting", () => {
  assert.equal(documentPostingPermission("customer_payment"), "ar.pay");
  assert.equal(documentPostingPermission("vendor_payment"), "ap.pay");
  assert.equal(documentPostingPermission("journal"), "gl.post");
  assert.equal(documentPostingPermission("expense_report"), "ap.post");
  assert.equal(documentPostingPermission("customer_invoice"), "ar.post");
  assert.equal(documentKindPermissions("pay_run")!.approve, "payroll.manage");
  assert.equal(documentPostingPermission("pay_run"), "gl.post");
  assert.equal(documentPostingPermission("unknown"), null);
  assert.equal(
    documentRouteEditPermission("customer_payment"),
    null,
    "effect recovery cannot admit a payment to generic document editing",
  );
  assert.throws(
    () => postPermission("customer_payment"),
    /unknown document kind/,
    "drawer-registry posting keeps its dedicated lifecycle boundary",
  );
});
