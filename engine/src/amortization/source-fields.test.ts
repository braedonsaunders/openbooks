import assert from "node:assert/strict";
import test from "node:test";
import { amortizationLineRefusal } from "./source-fields.ts";

test("a deferred journal expense retains its service period", () => {
  assert.equal(
    amortizationLineRefusal("journal", {
      amortizationTemplateId: "template",
      amortizationStartOn: "2028-02-29",
      amortizationEndOn: "2028-03-31",
    }),
    null,
  );
});

test("service dates require a template and a valid ordered calendar period", () => {
  assert.match(
    amortizationLineRefusal("journal", { amortizationStartOn: "2028-02-29" })!,
    /choose an amortization template/,
  );
  assert.match(
    amortizationLineRefusal("journal", {
      amortizationTemplateId: "template",
      amortizationStartOn: "2027-02-29",
    })!,
    /valid YYYY-MM-DD/,
  );
  assert.match(
    amortizationLineRefusal("journal", {
      amortizationTemplateId: "template",
      amortizationStartOn: "2028-03-31",
      amortizationEndOn: "2028-02-29",
    })!,
    /before/,
  );
});

test("unsupported source kinds refuse deferral while ordinary lines stay valid", () => {
  assert.match(
    amortizationLineRefusal("invoice", { amortizationTemplateId: "template" })!,
    /only vendor bill/,
  );
  assert.equal(amortizationLineRefusal("invoice", {}), null);
});
