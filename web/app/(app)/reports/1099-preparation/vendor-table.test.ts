import assert from "node:assert/strict";
import test from "node:test";
import { isFieldRef } from "@braedonsaunders/appkit-viewspec";
import { mapNecVendorRow, necPaymentColumns, necVendorColumns } from "./vendor-table";

const vendorHeader = {
  vendor: "Vendor",
  tin: "TIN",
  box1: "Box 1",
  withheld: "Withheld",
  total: "Total",
  threshold: "Threshold",
  payments: "Payments",
  cardPaid: "Card paid",
  notes: "Notes",
};

const paymentHeader = { date: "Date", number: "Number", cash: "Cash" };

const baseSource = {
  partyId: "019f0000-0000-4000-8000-000000000021",
  vendorName: "Acme Contracting",
  tinLast4: null,
  box1: "1200.00",
  withheld: "0.00",
  reportableTotal: "1200.00",
  belowThreshold: false,
  paymentCount: 3,
  cardPaid: "0",
  exclusionKinds: [] as string[],
  exclusionDetails: [] as string[],
};

const baseOpts = {
  formatMoney: (value: string) => `$${value}`,
  missingTinText: "No TIN on file",
  thresholdBelow: "Below threshold",
  thresholdReportable: "Reportable",
  cardExcludedText: (amount: string) => `card excluded ${amount}`,
  vendorHref: "/reports/1099-preparation?vendor=019f0000-0000-4000-8000-000000000021",
  vendorDrawerHref: "/parties?party=019f0000-0000-4000-8000-000000000021&partyTab=compliance",
  boxRulesHref: "/admin/setup/information-return-box-rules",
};

function linkCells(columns: ReturnType<typeof necVendorColumns>) {
  return columns
    .map((column) => column.cell)
    .filter((cell): cell is Extract<typeof cell, { kind: "link" }> => cell.kind === "link");
}

test("worksheet link cells resolve row fields, never nested cell objects", () => {
  for (const columns of [
    necVendorColumns(vendorHeader, { hasCardPaid: false }),
    necVendorColumns(vendorHeader, { hasCardPaid: true }),
    necPaymentColumns(paymentHeader),
  ]) {
    assert.ok(columns.length > 0);
    for (const cell of linkCells(columns as ReturnType<typeof necVendorColumns>)) {
      // A nested cell object here stringifies to "[object Object]" in the
      // rendered report; only field references resolve to row text.
      assert.ok(
        isFieldRef(cell.field),
        `link label must be a field ref, got ${JSON.stringify(cell.field)}`,
      );
      assert.ok(
        isFieldRef(cell.href),
        `link href must be a field ref, got ${JSON.stringify(cell.href)}`,
      );
    }
  }
});

test("payments count links to the vendor payment drill-down", () => {
  const columns = necVendorColumns(vendorHeader, { hasCardPaid: false });
  const payments = linkCells(columns).find((cell) => cell.href.$ === "vendorHref");
  assert.ok(payments, "a payments link must target the vendor drill-down");
  assert.equal(payments.field.$, "paymentCount");
});

test("payment numbers link to the payment drawer target", () => {
  const columns = necPaymentColumns(paymentHeader);
  const numbers = columns
    .map((column) => column.cell)
    .find((cell): cell is Extract<typeof cell, { kind: "link" }> => cell.kind === "link");
  assert.ok(numbers, "a payment number link must exist");
  assert.equal(numbers.field.$, "documentNumber");
  assert.equal(numbers.href.$, "paymentHref");
});

test("missing TIN links to the vendor record behind the tax switch", () => {
  const missing = mapNecVendorRow(baseSource, baseOpts);
  assert.equal(missing.tinText, "No TIN on file");
  assert.equal(
    missing.tinHref,
    "/parties?party=019f0000-0000-4000-8000-000000000021&partyTab=compliance",
  );
  const present = mapNecVendorRow({ ...baseSource, tinLast4: "1234" }, baseOpts);
  assert.equal(present.tinText, "•••1234");
  assert.equal(present.tinHref, "");
});

test("unmapped accounts link the notes cell to the box mapping setup", () => {
  const unmapped = mapNecVendorRow(
    {
      ...baseSource,
      exclusionKinds: ["unmapped_account"],
      exclusionDetails: ['spend on "Supplies" has no box rule and fell to the default box'],
    },
    baseOpts,
  );
  assert.ok(unmapped.exclusionNote.includes("has no box rule"));
  assert.equal(unmapped.exclusionHref, "/admin/setup/information-return-box-rules");
  const other = mapNecVendorRow(
    {
      ...baseSource,
      exclusionKinds: ["corporation_flagged"],
      exclusionDetails: ["classified C-Corp — corporations are generally not reportable"],
    },
    baseOpts,
  );
  assert.equal(other.exclusionHref, "");
});

test("payment counts render as plain decimal strings", () => {
  const mapped = mapNecVendorRow(baseSource, baseOpts);
  assert.equal(mapped.paymentCount, "3");
  assert.equal(mapped.vendorHref, baseOpts.vendorHref);
});
