import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { JsonValue } from "../app/(app)/admin/audit/AuditEventDrawer";
import { promotionNextStep, type PromotionState } from "./sandbox-promotion";

const captured: PromotionState = { status: "draft", captureComplete: true, itemCount: 1, capturedCount: 1, baseComplete: true, createdBy: "creator", reviewedBy: null, approvedBy: null };
test("legacy and partial captures cannot be advanced by the review screen", () => {
  for (const invalid of [{ baseComplete: false }, { captureComplete: false }, { capturedCount: 0 }]) {
    const step = promotionNextStep({ ...captured, ...invalid }, "reviewer");
    assert.equal(step.transition, null);
    assert.match(step.reason!, /capture/i);
  }
});
test("promotion evidence preserves small numeric policy values instead of rounding them away", () => {
  const html = renderToStaticMarkup(<NextIntlClientProvider locale="en" timeZone="UTC" messages={{}} onError={() => undefined}>
    <JsonValue value={{ nested: [{ rate: 0.000000125 }] }} exactNumbers />
  </NextIntlClientProvider>);
  assert.match(html, /1\.25e-7/);
});
