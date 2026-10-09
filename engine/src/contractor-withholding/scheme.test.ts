import assert from "node:assert/strict";
import { test } from "node:test";
import { contractorWithholdingScheme } from "../country-tax-packs/index.ts";
import {
  aggregateReturn,
  composeBill,
  computeDeduction,
  ContractorWithholdingError,
  withholdingPeriod,
  retainedBillLines,
  type WithholdingBillLine,
  type WithholdingStanding,
} from "./scheme.ts";

const CIS = contractorWithholdingScheme("GB_CIS")!;
const BAU = contractorWithholdingScheme("DE_BAUABZUG")!;
const RCT = contractorWithholdingScheme("IE_RCT")!;

function standing(over: Partial<WithholdingStanding> = {}): WithholdingStanding {
  return {
    id: "standing", bandCode: "NET", verificationReference: "V1234567890", validFrom: "2026-04-06",
    validTo: null, status: "active", applyFromFirstPayment: false, ...over,
  };
}

const line = (amount: string, vat: string, treatment: WithholdingBillLine["treatment"], retainage = false, materialsCost?: string | null): WithholdingBillLine =>
  ({ amount, vat, treatment, retainage, materialsCost });
const noHistory = { consideration: "0", pendingBase: "0" };

test("CIS excludes direct materials cost and VAT while keeping the material markup in the paid base", () => {
  const bill = composeBill(CIS, [line("1000", "200", "labour"), line("400", "80", "materials", false, "300")]);
  const full = computeDeduction({
    scheme: CIS, standing: standing(), paymentDate: "2026-10-01", currency: "GBP",
    composition: bill, paid: "1680", thresholdBasis: null, history: noHistory,
  });
  assert.equal(full.bandCode, "NET");
  assert.equal(full.share.base, "1100.0000");
  assert.equal(full.share.materials, "300.0000");
  assert.equal(full.share.net, "1400.0000");
  assert.equal(full.deducted, "220.0000");

  const half = computeDeduction({
    scheme: CIS, standing: standing(), paymentDate: "2026-10-01", currency: "GBP",
    composition: bill, paid: "840", thresholdBasis: null, history: noHistory,
  });
  assert.equal(half.share.base, "550.0000");
  assert.equal(half.deducted, "110.0000");
});

test("a retention is read through the work lines it holds back", () => {
  const bill = composeBill(CIS, [line("600", "0", "labour"), line("400", "0", "materials", false, "300"), line("-100", "0", "labour", true)]);
  const figures = computeDeduction({
    scheme: CIS, standing: standing(), paymentDate: "2026-10-01", currency: "GBP",
    composition: bill, paid: "900", thresholdBasis: null, history: noHistory,
  });
  assert.equal(figures.share.base, "630.0000");
  assert.equal(figures.deducted, "126.0000");

  const release = composeBill(CIS, [line("100", "0", "labour", true)]);
  assert.equal(computeDeduction({
    scheme: CIS, standing: standing(), paymentDate: "2026-12-01", currency: "GBP",
    composition: release, paid: "100", thresholdBasis: null, history: noHistory,
  }).deducted, "20.0000");
});

test("a reduced band without a current verification falls to the highest band, and says why", () => {
  const bill = composeBill(CIS, [line("1000", "0", "labour")]);
  const expired = computeDeduction({
    scheme: CIS, standing: standing({ bandCode: "GROSS", validTo: "2026-09-30" }), paymentDate: "2026-10-01",
    currency: "GBP", composition: bill, paid: "1000", thresholdBasis: null, history: noHistory,
  });
  assert.equal(expired.bandCode, "HIGHER");
  assert.equal(expired.downgradedFrom, "GROSS");
  assert.equal(expired.deducted, "300.0000");
  assert.deepEqual(expired.reasons.map((r) => r.code), ["verification_not_current"]);

  const unverified = computeDeduction({
    scheme: CIS, standing: standing({ verificationReference: " " }), paymentDate: "2026-10-01",
    currency: "GBP", composition: bill, paid: "1000", thresholdBasis: null, history: noHistory,
  });
  assert.deepEqual([unverified.bandCode, unverified.reasons[0]!.code], ["HIGHER", "verification_missing"]);

  const revoked = computeDeduction({
    scheme: RCT, standing: standing({ bandCode: "ZERO", status: "revoked" }), paymentDate: "2026-10-01",
    currency: "EUR", composition: composeBill(RCT, [line("1000", "0", "labour")]), paid: "1000",
    thresholdBasis: null, history: noHistory,
  });
  assert.deepEqual([revoked.bandCode, revoked.deducted], ["HIGHER", "350.0000"]);
});

test("§ 48 EStG deducts on the consideration including VAT once the annual limit is crossed, catching up the year", () => {
  const bill = composeBill(BAU, [line("10000", "1900", "labour"), line("5000", "950", "materials")]);
  const std = standing({ bandCode: "STANDARD", verificationReference: null });
  const first = computeDeduction({
    scheme: BAU, standing: std, paymentDate: "2026-03-10", currency: "EUR",
    composition: bill, paid: "4000", thresholdBasis: null, history: noHistory,
  });
  assert.equal(first.belowThreshold, true);
  assert.equal(first.deducted, "0.0000");
  assert.equal(first.share.base, "4000.0000");

  const crossing = computeDeduction({
    scheme: BAU, standing: std, paymentDate: "2026-04-10", currency: "EUR", composition: bill, paid: "2000",
    thresholdBasis: null, history: { consideration: first.share.consideration, pendingBase: first.share.base },
  });
  assert.equal(crossing.belowThreshold, false);
  assert.equal(crossing.catchUpBase, "4000.0000");
  assert.equal(crossing.deducted, "900.0000");

  const letting = computeDeduction({
    scheme: BAU, standing: std, paymentDate: "2026-04-10", currency: "EUR", composition: bill, paid: "2000",
    thresholdBasis: "exempt_letting", history: { consideration: "8000", pendingBase: "8000" },
  });
  assert.equal(letting.belowThreshold, true);

  const exempt = computeDeduction({
    scheme: BAU, standing: standing({ bandCode: "EXEMPT", verificationReference: "FB-2026-17", validTo: "2026-12-31" }),
    paymentDate: "2026-04-10", currency: "EUR", composition: bill, paid: "11900", thresholdBasis: null,
    history: { consideration: "9000", pendingBase: "9000" },
  });
  assert.deepEqual([exempt.bandCode, exempt.deducted], ["EXEMPT", "0.0000"]);
});

test("§ 48 catch-up is limited to the available consideration and the excess is not a liability", () => {
  const result = computeDeduction({
    scheme: BAU, standing: standing({ bandCode: "STANDARD", verificationReference: null }), paymentDate: "2026-11-02",
    currency: "EUR", composition: composeBill(BAU, [line("100", "0", "labour")]), paid: "100",
    thresholdBasis: null, history: { consideration: "4950", pendingBase: "4950" },
  });
  assert.equal(result.deducted,"100.0000");
  assert.equal(result.uncollected,"0.0000");
  assert.equal(result.reasons.find(reason => reason.code === "deduction_capped")?.amount,"657.5000");
});

test("foreign payments refuse missing explicit statutory exchange rates", () => {
  assert.throws(() => computeDeduction({
    scheme: CIS, standing: standing(), paymentDate: "2026-10-01", currency: "EUR",
    composition: composeBill(CIS, [line("100", "0", "labour")]), paid: "100", thresholdBasis: null, history: noHistory,
  }), ContractorWithholdingError);
});

test("foreign statutory bases preserve direct materials and VAT treatment", () => {
  const figures = computeDeduction({
    scheme: CIS, standing: standing(), paymentDate: "2026-10-01", currency: "EUR", reportingFxRate: "0.8",
    composition: composeBill(CIS, [line("1000", "200", "labour"), line("400", "80", "materials", false, "300")]),
    paid: "1680", thresholdBasis: null, history: noHistory,
  });
  assert.equal(figures.share.paid, "1344.0000");
  assert.equal(figures.share.materials, "240.0000");
  assert.equal(figures.share.vat, "224.0000");
  assert.equal(figures.share.base, "880.0000");
  assert.equal(figures.deducted, "176.0000");
});

test("foreign threshold catch-up uses statutory history across different payment quotes", () => {
  const bill = composeBill(BAU, [line("10000", "0", "labour")]);
  const std = standing({ bandCode: "STANDARD", verificationReference: null });
  const first = computeDeduction({ scheme: BAU, standing: std, paymentDate: "2026-03-10", currency: "GBP", reportingFxRate: "1.25", composition: bill, paid: "3200", thresholdBasis: null, history: noHistory });
  assert.equal(first.share.consideration, "4000.0000");
  assert.equal(first.belowThreshold, true);
  const next = computeDeduction({ scheme: BAU, standing: std, paymentDate: "2026-04-10", currency: "USD", reportingFxRate: "0.8", composition: bill, paid: "2000", thresholdBasis: null, history: { consideration: first.share.consideration, pendingBase: first.share.base } });
  assert.equal(next.share.consideration, "1600.0000");
  assert.equal(next.catchUpBase, "4000.0000");
  assert.equal(next.deducted, "840.0000");
});

test("deduction periods follow each scheme's month and statutory due dates", () => {
  assert.deepEqual(withholdingPeriod(CIS, "2026-10-05"), {
    start: "2026-09-06", end: "2026-10-05", returnDue: "2026-10-19", paymentDue: "2026-10-22",
  });
  assert.deepEqual(withholdingPeriod(CIS, "2026-10-06").start, "2026-10-06");
  assert.deepEqual(withholdingPeriod(BAU, "2026-12-31"), {
    start: "2026-12-01", end: "2026-12-31", returnDue: "2027-01-10", paymentDue: "2027-01-10",
  });
});

test("a return aggregates each payee's deductions", () => {
  const base = {
    payeeReference: "1234567890", verificationReference: null, bandCode: "NET", vat: "0", consideration: "0", uncollected: "0",
  };
  const { lines, totals } = aggregateReturn([
    { ...base, partyId: "b", payeeName: "Bricks Ltd", paid: "100", net: "100", materials: "20", base: "80", deducted: "16" },
    { ...base, partyId: "a", payeeName: "Allbuild", paid: "50", net: "50", materials: "0", base: "50", deducted: "10" },
    { ...base, partyId: "b", payeeName: "Bricks Ltd", paid: "200", net: "200", materials: "0", base: "200", deducted: "40" },
  ]);
  assert.deepEqual(lines.map((l) => [l.payeeName, l.deducted]), [["Allbuild", "10.0000"], ["Bricks Ltd", "56.0000"]]);
  assert.equal(totals.deducted, "66.0000");
  assert.equal(totals.materials, "20.0000");
});


test("CIS refuses missing, malformed, negative or excessive direct costs instead of assuming material selling price", () => {
  for (const cost of [undefined, null, "", "300.00001", "3e2", "-1", "400.0001", 300 as never]) {
    assert.throws(() => composeBill(CIS, [line("400", "0", "materials", false, cost)]), ContractorWithholdingError);
  }
  assert.equal(composeBill(CIS, [line("400", "0", "materials", false, "0")]).base, 4000000n);
  assert.equal(composeBill(CIS, [line("400", "0", "excluded")]).base, 0n);
  // A recorded cost cannot change a scheme that taxes materials in full.
  assert.equal(composeBill(BAU, [line("400", "80", "materials", false, "300")]).base, 4800000n);
  assert.equal(composeBill(RCT, [line("400", "80", "materials")]).base, 4000000n);
});

test("a non-VAT-registered subcontractor's receipt VAT remains in the explicitly entered direct cost", () => {
  const composition = composeBill(CIS, [line("1000", "0", "labour"), line("400", "0", "materials", false, "360")]);
  const figures = computeDeduction({ scheme: CIS, standing: standing(), paymentDate: "2026-10-01", currency: "GBP",
    composition, paid: "1400", thresholdBasis: null, history: noHistory });
  assert.equal(figures.share.materials, "360.0000");
  assert.equal(figures.deducted, "208.0000");
});

test("successive retained releases carry the original work mix and the exact residual direct cost", () => {
  const work = [line("1000", "0", "labour"), line("400", "0", "materials", false, "300.1234"), line("-140", "0", "excluded", true)];
  const first = retainedBillLines(work, "70", "0");
  const last = retainedBillLines(work, "70", "70");
  assert.equal(first.find(line => line.treatment === "materials")!.materialsCost, "15.0062");
  assert.equal(last.find(line => line.treatment === "materials")!.materialsCost, "15.0061");
  const release = composeBill(CIS, retainedBillLines(work, "140", "0"));
  assert.equal(release.materials, 300123n);
  assert.equal(release.net, 1400000n);
  const paid = computeDeduction({ scheme: CIS, standing: standing(), paymentDate: "2026-12-01", currency: "GBP",
    composition: release, paid: "70", thresholdBasis: null, history: noHistory });
  assert.equal(paid.share.materials, "15.0100");
  assert.equal(paid.deducted, "11.0000");
  assert.throws(() => composeBill(CIS, retainedBillLines([line("400", "0", "materials")], "40", "0")), /explicit direct materials cost/);
});


test("RCT quarterly periods and annual backup withholding preserve their declared filing periods", () => {
  assert.deepEqual(withholdingPeriod(RCT, "2026-11-02", "quarterly"), { start:"2026-10-01",end:"2026-12-31",returnDue:"2027-01-23",paymentDue:"2027-01-23" });
  assert.throws(() => withholdingPeriod(CIS, "2026-11-02", "quarterly"), /does not declare/);
  const backup = contractorWithholdingScheme("US_BACKUP_WITHHOLDING")!;
  assert.deepEqual(withholdingPeriod(backup, "2026-07-05"), { start:"2026-01-01",end:"2026-12-31",returnDue:"2027-01-31",paymentDue:null });
});


test("an exemption certificate without its required expiry cannot silently become permanent", () => {
  const figures = computeDeduction({ scheme: BAU, standing: standing({ bandCode: 'EXEMPT', verificationReference: 'CERT-2026', validTo: null, applyFromFirstPayment: true }),
    paymentDate: '2026-10-01', currency: 'EUR', composition: composeBill(BAU, [line('1000', '190', 'labour')]), paid: '1190', thresholdBasis: null, history: noHistory });
  assert.equal(figures.bandCode, 'STANDARD');
  assert.equal(figures.deducted, '178.5000');
  assert.match(figures.reasons[0]!.message, /expiry date/);
});
