import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePaymentProviderView,
  surchargeRuleDrawerHrefs,
} from "./payment-provider-navigation.ts";

test("a new-rule URL selects surcharge rules unless an explicit view takes precedence", () => {
  assert.equal(resolvePaymentProviderView(null, "checkout", true), "surcharge");
  assert.equal(
    resolvePaymentProviderView("processor_receipts", "checkout", true),
    "processor_receipts",
  );
  assert.equal(resolvePaymentProviderView("unrecognized", "settlement", false), "settlement");
});

test("surcharge drawer URLs preserve list filters and remove only the drawer selector on close", () => {
  const hrefs = surchargeRuleDrawerHrefs(
    "/admin/setup/payment-providers",
    "?q=card&page=2&rule=new",
  );
  assert.equal(hrefs.closeHref, "/admin/setup/payment-providers?q=card&page=2&view=surcharge");
  assert.equal(
    hrefs.newHref,
    "/admin/setup/payment-providers?q=card&page=2&view=surcharge&rule=new",
  );
});
