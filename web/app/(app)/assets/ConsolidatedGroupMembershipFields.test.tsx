import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import type { TaxAssetBasisSourceChoice } from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import { ConsolidatedGroupMembershipFields } from "./ConsolidatedGroupMembershipFields";

Object.assign(globalThis, { React });
const common = JSON.parse(readFileSync(new URL("../../../messages/en/common.json", import.meta.url), "utf8"));
const ui = JSON.parse(readFileSync(new URL("../../../messages/en/ui.json", import.meta.url), "utf8"));
const source: TaxAssetBasisSourceChoice = {
  key: "transfer-source", sourceChangeId: "source-change", sourceEventId: null,
  occurredOn: "2026-07-01", sourceKind: "transferred", sourceOperation: "intercompany_transfer",
  bookLabel: "Primary", assetLabel: "FA-101 — Equipment", subsidiaryLabel: "Seller company",
  receivingAssetLabel: "FA-202 — Equipment", receivingSubsidiaryLabel: "Buyer company",
  sellerSubsidiaryId: "11111111-1111-4111-8111-111111111111",
  buyerSubsidiaryId: "22222222-2222-4222-8222-222222222222",
  regimes: [{ code: "us_macrs", name: "United States — MACRS", applicable: "both" }],
  openMacrsVintages: { status: "original_declaration_required" }, appliedWorkpaper: null,
};
function render(props: Partial<Parameters<typeof ConsolidatedGroupMembershipFields>[0]> = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ common, ui }}>
      <ConsolidatedGroupMembershipFields source={source} onChange={() => {}} {...props} />
    </NextIntlClientProvider>,
  );
}

test("membership starts unsupplied and never infers dates or entities from a depreciation election", () => {
  const markup = render();
  assert.match(markup, /No membership has been declared/);
  assert.match(markup, /<option value="" selected="">Not supplied/);
  assert.match(markup, /Seller: Seller company/);
  assert.match(markup, /Buyer: Buyer company/);
  assert.doesNotMatch(markup, /<input\b/);
  assert.doesNotMatch(markup, /11111111|22222222|2026-07-01/);
});

test("declared membership uses native group and date controls with fixed source entity labels", () => {
  const markup = render({ value: {
    groupKey: "US income-tax group A",
    sellerSubsidiaryId: source.sellerSubsidiaryId,
    buyerSubsidiaryId: source.buyerSubsidiaryId!,
    effectiveOn: "2026-01-01", throughOn: "2026-12-31",
  } });
  assert.match(markup, /<input[^>]*required=""[^>]*value="US income-tax group A"/);
  assert.match(markup, /type="date"[^>]*value="2026-01-01"/);
  assert.match(markup, /type="date"[^>]*value="2026-12-31"/);
  assert.doesNotMatch(markup, /11111111|22222222|<textarea\b/,
    "the operator must never type entity UUIDs or raw membership JSON");
  assert.doesNotMatch(markup, /<(?:input|select)[^>]*(?:deferred|carryover|gain|buyerCost)/);
});

test("an unavailable source identity refuses membership entry and external disposals have no membership editor", () => {
  const unavailable = render({ source: { ...source, buyerSubsidiaryId: null, receivingSubsidiaryLabel: null } });
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Reload the source before declaring/);
  assert.match(unavailable, /<select[^>]*disabled=""/);
  const disposal = render({ source: { ...source, sourceOperation: "partial_disposal" } });
  assert.equal(disposal, "");
});
