import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sum } from "./money.ts";
import {
  allocatePaymentToBoxes,
  allocateProportionally,
  canFurnishRecipientCopies,
  filedBoxAmounts,
  filedTotal,
  formDefinition,
  INFORMATION_RETURN_FORMS,
  recipientExceptions,
  summarizeRecipient,
  type PaymentTrace,
  type RecipientProfile,
} from "./information-returns.ts";

const NEC = formDefinition("1099-NEC");
const MISC = formDefinition("1099-MISC");

// --- exact allocation -----------------------------------------------------

test("proportional allocation always re-adds to the total", () => {
  const cases: [string, string[]][] = [
    ["100.0000", ["1", "1", "1"]],
    ["0.0003", ["1", "1", "1"]],
    ["9999.9999", ["7", "11", "13", "17"]],
    ["1000.0000", ["333.3333", "333.3333", "333.3334"]],
    ["12345.6789", ["1"]],
  ];
  for (const [total, weights] of cases) {
    const parts = allocateProportionally(total, weights);
    assert.equal(sum(parts), total, `${total} over ${weights.join("/")}`);
    assert.equal(parts.length, weights.length);
  }
});

test("a one-unit remainder goes to the largest remainder, deterministically", () => {
  assert.deepEqual(allocateProportionally("0.0001", ["1", "1", "1"]), ["0.0001", "0.0000", "0.0000"]);
  assert.deepEqual(allocateProportionally("0.0002", ["1", "1", "1"]), ["0.0001", "0.0001", "0.0000"]);
  // Repeat runs never differ: no Map/Set iteration order in the result.
  const a = allocateProportionally("100.0001", ["3", "3", "3", "1"]);
  const b = allocateProportionally("100.0001", ["3", "3", "3", "1"]);
  assert.deepEqual(a, b);
  assert.equal(sum(a), "100.0001");
});

test("zero weights keep the cash rather than dropping it", () => {
  assert.deepEqual(allocateProportionally("500.0000", ["0", "0"]), ["500.0000", "0.0000"]);
  assert.deepEqual(allocateProportionally("0.0000", ["5", "5"]), ["0.0000", "0.0000"]);
});

test("an empty weight vector allocates nothing", () => {
  assert.deepEqual(allocateProportionally("500.0000", []), []);
});

// --- payment → box allocation --------------------------------------------

function payment(over: Partial<PaymentTrace> = {}): PaymentTrace {
  return {
    paymentId: "pay-1",
    documentNumber: "PAY-0001",
    paymentDate: "2026-03-15",
    cash: "1000.0000",
    bills: [{ documentId: "bill-1", applied: "1000.0000", lines: [{ accountId: "acct-sub", weight: "1000.0000" }] }],
    ...over,
  };
}

test("a payment settling one mapped bill lands wholly in that box", () => {
  const { boxAmounts, unmappedAccountIds } = allocatePaymentToBoxes({
    payment: payment(),
    boxByAccount: new Map([["acct-sub", "nec1"]]),
    defaultBox: "nec1",
  });
  assert.deepEqual(boxAmounts, { nec1: "1000.0000" });
  assert.deepEqual(unmappedAccountIds, []);
});

test("spend split across accounts splits across boxes, penny-exact", () => {
  const { boxAmounts } = allocatePaymentToBoxes({
    payment: payment({
      cash: "1000.0000",
      bills: [
        {
          documentId: "bill-1",
          applied: "1000.0000",
          lines: [
            { accountId: "acct-sub", weight: "700.0000" },
            { accountId: "acct-rent", weight: "300.0000" },
          ],
        },
      ],
    }),
    boxByAccount: new Map([
      ["acct-sub", "misc3"],
      ["acct-rent", "misc1"],
    ]),
    defaultBox: "misc3",
  });
  assert.deepEqual(boxAmounts, { misc3: "700.0000", misc1: "300.0000" });
  assert.equal(sum(Object.values(boxAmounts)), "1000.0000");
});

test("an indivisible split still re-adds to the cash paid", () => {
  const { boxAmounts } = allocatePaymentToBoxes({
    payment: payment({
      cash: "100.0000",
      bills: [
        {
          documentId: "bill-1",
          applied: "100.0000",
          lines: [
            { accountId: "a", weight: "1" },
            { accountId: "b", weight: "1" },
            { accountId: "c", weight: "1" },
          ],
        },
      ],
    }),
    boxByAccount: new Map([
      ["a", "misc1"],
      ["b", "misc2"],
      ["c", "misc3"],
    ]),
    defaultBox: "misc3",
  });
  assert.equal(sum(Object.values(boxAmounts)), "100.0000");
});

test("a partial payment reports only the cash that left, not the bill", () => {
  const { boxAmounts } = allocatePaymentToBoxes({
    payment: payment({
      cash: "400.0000",
      bills: [{ documentId: "bill-1", applied: "400.0000", lines: [{ accountId: "acct-sub", weight: "1000.0000" }] }],
    }),
    boxByAccount: new Map([["acct-sub", "nec1"]]),
    defaultBox: "nec1",
  });
  assert.deepEqual(boxAmounts, { nec1: "400.0000" });
});

test("an early-payment discount reports the cash paid, not the bill settled", () => {
  // $1,000 bill settled with $980 of cash and a $20 discount: the recipient
  // received $980, and that is the reportable figure.
  const { boxAmounts } = allocatePaymentToBoxes({
    payment: payment({
      cash: "980.0000",
      bills: [{ documentId: "bill-1", applied: "1000.0000", lines: [{ accountId: "acct-sub", weight: "1000.0000" }] }],
    }),
    boxByAccount: new Map([["acct-sub", "nec1"]]),
    defaultBox: "nec1",
  });
  assert.deepEqual(boxAmounts, { nec1: "980.0000" });
});

test("cash beyond what it settled is an advance and lands in the default box", () => {
  const { boxAmounts } = allocatePaymentToBoxes({
    payment: payment({
      cash: "1500.0000",
      bills: [{ documentId: "bill-1", applied: "1000.0000", lines: [{ accountId: "acct-rent", weight: "1000.0000" }] }],
    }),
    boxByAccount: new Map([["acct-rent", "misc1"]]),
    defaultBox: "misc3",
  });
  assert.deepEqual(boxAmounts, { misc1: "1000.0000", misc3: "500.0000" });
});

test("a payment settling nothing is still reported", () => {
  const { boxAmounts } = allocatePaymentToBoxes({
    payment: payment({ cash: "2500.0000", bills: [] }),
    boxByAccount: new Map(),
    defaultBox: "nec1",
  });
  assert.deepEqual(boxAmounts, { nec1: "2500.0000" });
});

test("a settled bill with no decomposable lines falls to the default box", () => {
  const { boxAmounts } = allocatePaymentToBoxes({
    payment: payment({
      cash: "800.0000",
      bills: [{ documentId: "bill-1", applied: "800.0000", lines: [{ accountId: "acct", weight: "0" }] }],
    }),
    boxByAccount: new Map([["acct", "misc1"]]),
    defaultBox: "misc3",
  });
  assert.deepEqual(boxAmounts, { misc3: "800.0000" });
});

test("unmapped accounts are named so the mapping gap is visible", () => {
  const { boxAmounts, unmappedAccountIds } = allocatePaymentToBoxes({
    payment: payment({
      cash: "1000.0000",
      bills: [
        {
          documentId: "bill-1",
          applied: "1000.0000",
          lines: [
            { accountId: "known", weight: "600.0000" },
            { accountId: "mystery", weight: "400.0000" },
          ],
        },
      ],
    }),
    boxByAccount: new Map([["known", "nec1"]]),
    defaultBox: "nec1",
  });
  assert.deepEqual(unmappedAccountIds, ["mystery"]);
  assert.deepEqual(boxAmounts, { nec1: "1000.0000" });
});

test("one payment across two bills allocates per bill", () => {
  const { boxAmounts } = allocatePaymentToBoxes({
    payment: payment({
      cash: "3000.0000",
      bills: [
        { documentId: "b1", applied: "1000.0000", lines: [{ accountId: "rent", weight: "1000.0000" }] },
        { documentId: "b2", applied: "2000.0000", lines: [{ accountId: "sub", weight: "2000.0000" }] },
      ],
    }),
    boxByAccount: new Map([
      ["rent", "misc1"],
      ["sub", "misc3"],
    ]),
    defaultBox: "misc3",
  });
  assert.deepEqual(boxAmounts, { misc1: "1000.0000", misc3: "2000.0000" });
});

// --- recipient roll-up ---------------------------------------------------

test("a recipient's boxes re-add to the cash traced", () => {
  const { amounts } = summarizeRecipient({
    form: MISC,
    payments: [
      payment({ paymentId: "p1", cash: "333.3333" }),
      payment({ paymentId: "p2", cash: "666.6667", bills: [] }),
    ],
    boxByAccount: new Map([["acct-sub", "misc1"]]),
    defaultBox: "misc3",
    filingThreshold: "600",
  });
  assert.equal(amounts.tracedCash, "1000.0000");
  assert.equal(sum(Object.values(amounts.boxAmounts)), "1000.0000");
  assert.equal(amounts.paymentCount, 2);
});

test("withholding is excluded from the reportable total", () => {
  const { amounts } = summarizeRecipient({
    form: NEC,
    payments: [
      payment({
        cash: "1000.0000",
        bills: [
          {
            documentId: "bill-1",
            applied: "1000.0000",
            lines: [
              { accountId: "sub", weight: "900.0000" },
              { accountId: "withheld", weight: "100.0000" },
            ],
          },
        ],
      }),
    ],
    boxByAccount: new Map([
      ["sub", "nec1"],
      ["withheld", "nec4"],
    ]),
    defaultBox: "nec1",
    filingThreshold: "600",
  });
  assert.equal(amounts.reportableTotal, "900.0000");
  assert.equal(amounts.withheld, "100.0000");
});

test("the threshold is judged on the reportable total", () => {
  const under = summarizeRecipient({
    form: NEC,
    payments: [payment({ cash: "599.9999" })],
    boxByAccount: new Map([["acct-sub", "nec1"]]),
    defaultBox: "nec1",
    filingThreshold: "600",
  });
  assert.equal(under.belowThreshold, true);
  const at = summarizeRecipient({
    form: NEC,
    payments: [payment({ cash: "600.0000" })],
    boxByAccount: new Map([["acct-sub", "nec1"]]),
    defaultBox: "nec1",
    filingThreshold: "600",
  });
  assert.equal(at.belowThreshold, false);
});

test("a box with its own lower threshold files on its own", () => {
  // $15 of royalties is reportable even though the filing threshold is $600.
  const royalties = summarizeRecipient({
    form: MISC,
    payments: [
      payment({
        cash: "15.0000",
        bills: [{ documentId: "b", applied: "15.0000", lines: [{ accountId: "roy", weight: "15.0000" }] }],
      }),
    ],
    boxByAccount: new Map([["roy", "misc2"]]),
    defaultBox: "misc3",
    filingThreshold: "600",
  });
  assert.equal(royalties.belowThreshold, false);
});

test("any withholding at all makes a recipient reportable", () => {
  const withheld = summarizeRecipient({
    form: NEC,
    payments: [
      payment({
        cash: "100.0000",
        bills: [
          {
            documentId: "b",
            applied: "100.0000",
            lines: [
              { accountId: "sub", weight: "90.0000" },
              { accountId: "wh", weight: "10.0000" },
            ],
          },
        ],
      }),
    ],
    boxByAccount: new Map([
      ["sub", "nec1"],
      ["wh", "nec4"],
    ]),
    defaultBox: "nec1",
    filingThreshold: "600",
  });
  assert.equal(withheld.belowThreshold, false);
});

// --- exceptions ----------------------------------------------------------

function profile(over: Partial<RecipientProfile> = {}): RecipientProfile {
  return {
    partyId: "p1",
    displayName: "Ace Framing",
    legalName: "Ace Framing LLC",
    reportable: true,
    resolvedForm: "1099-NEC",
    defaultBox: null,
    taxClassification: "llc",
    tinLast4: "1234",
    tinType: "ein",
    backupWithholding: false,
    address: {},
    ...over,
  };
}

const amounts = (total: string, boxes: Record<string, string> = { nec1: total }, withheld = "0") => ({
  boxAmounts: boxes,
  reportableTotal: total,
  withheld,
  paymentCount: 1,
  tracedCash: total,
});

const exceptionsFor = (p: RecipientProfile, total: string, opts: { belowThreshold?: boolean; boxes?: Record<string, string>; withheld?: string; unmapped?: string[] } = {}) =>
  recipientExceptions({
    profile: p,
    amounts: amounts(total, opts.boxes ?? { nec1: total }, opts.withheld ?? "0"),
    form: NEC,
    belowThreshold: opts.belowThreshold ?? false,
    filingThreshold: "600",
    unmappedAccountNames: opts.unmapped ?? [],
  }).map((e) => e.kind);

test("a filed recipient with no TIN is an exception", () => {
  assert.deepEqual(exceptionsFor(profile({ tinLast4: null }), "5000"), ["missing_tin"]);
  // Below the threshold it is not being filed, so it is not yet a problem.
  assert.deepEqual(exceptionsFor(profile({ tinLast4: null }), "100", { belowThreshold: true }), []);
});

test("a reportable vendor with no form assigned is an exception", () => {
  assert.deepEqual(exceptionsFor(profile({ resolvedForm: null }), "5000"), [
    "missing_form_assignment",
  ]);
  assert.deepEqual(exceptionsFor(profile({ resolvedForm: "none" }), "5000"), [
    "missing_form_assignment",
  ]);
});

test("a corporation flagged as reportable is queried, not silently filed", () => {
  assert.deepEqual(exceptionsFor(profile({ taxClassification: "c_corp" }), "5000"), [
    "corporation_flagged",
  ]);
  // …unless the box is one that stays reportable for corporations.
  assert.deepEqual(
    recipientExceptions({
      profile: profile({ taxClassification: "c_corp", resolvedForm: "1099-MISC" }),
      amounts: amounts("5000", { misc10: "5000" }),
      form: MISC,
      belowThreshold: false,
      filingThreshold: "600",
      unmappedAccountNames: [],
    }),
    [],
  );
});

test("an unflagged vendor paid over the threshold is surfaced", () => {
  assert.deepEqual(exceptionsFor(profile({ reportable: false }), "5000"), [
    "unflagged_over_threshold",
  ]);
  // A corporation is expected to be unflagged: no false alarm.
  assert.deepEqual(exceptionsFor(profile({ reportable: false, taxClassification: "s_corp" }), "5000"), []);
  assert.deepEqual(exceptionsFor(profile({ reportable: false }), "100"), []);
});

test("backup withholding with nothing withheld is surfaced", () => {
  assert.deepEqual(exceptionsFor(profile({ backupWithholding: true }), "5000"), [
    "backup_withholding_not_withheld",
  ]);
  assert.deepEqual(
    exceptionsFor(profile({ backupWithholding: true }), "5000", { boxes: { nec1: "5000", nec4: "1200" }, withheld: "1200" }),
    [],
  );
});

test("an unmapped account is reported per account, by name", () => {
  const found = recipientExceptions({
    profile: profile(),
    amounts: amounts("5000"),
    form: NEC,
    belowThreshold: false,
    filingThreshold: "600",
    unmappedAccountNames: ["5100 · Subcontractor Costs", "5200 · Equipment Rental"],
  });
  assert.deepEqual(found.map((e) => e.kind), ["unmapped_account", "unmapped_account"]);
  assert.ok(found[0]!.detail.includes("5100 · Subcontractor Costs"));
});

test("a clean recipient raises nothing", () => {
  assert.deepEqual(exceptionsFor(profile(), "5000"), []);
});

// --- filed figures -------------------------------------------------------

test("adjustments are added to the computed figure, never replacing it", () => {
  const filed = filedBoxAmounts({ nec1: "5000.0000" }, { nec1: "-250.0000", nec4: "100.0000" });
  assert.deepEqual(filed, { nec1: "4750.0000", nec4: "100.0000" });
});

test("the filed total excludes withholding and indicator boxes", () => {
  assert.equal(filedTotal(NEC, { nec1: "5000.0000", nec2: "1.0000", nec4: "600.0000" }), "5000.0000");
});

test("recipient copies can only be furnished from a frozen filing", () => {
  assert.equal(canFurnishRecipientCopies("draft"), false);
  assert.equal(canFurnishRecipientCopies("computed"), false);
  assert.equal(canFurnishRecipientCopies("finalized"), true);
  assert.equal(canFurnishRecipientCopies("filed"), true);
  assert.equal(canFurnishRecipientCopies("void"), false);

  const route = readFileSync(
    new URL("../../web/app/api/compliance/information-returns/[id]/copies/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    route.indexOf("if (!canFurnishRecipientCopies(filing.status))") < route.indexOf("const recipients"),
    "the copies route must refuse mutable filings before reading or rendering recipients",
  );
});

test("payment-trace cash is restricted to the funding bank leg", () => {
  // The loader's SQL owns the cash-source boundary. Keep this representative
  // contract test in the unit suite because the integration fixture would
  // require a database; a discount leg must not be eligible for this sum.
  const source = readFileSync(new URL("./information-returns.ts", import.meta.url), "utf8");
  const loader = source.slice(
    source.indexOf("export async function loadPaymentTraces"),
    source.indexOf("export async function loadRecipientProfiles"),
  );
  assert.match(loader, /join accounts funding on funding\.id = jl\.account_id/);
  assert.match(loader, /jl\.amount < 0 and not jl\.is_open_item and funding\.type = 'asset_bank'/);
  assert.equal(loader.match(/funding\.type = 'asset_bank'/g)?.length, 2);
});

// --- catalogue integrity -------------------------------------------------

test("every form's default box exists and box keys are unique", () => {
  for (const form of Object.values(INFORMATION_RETURN_FORMS)) {
    const keys = form.boxes.map((b) => b.key);
    assert.equal(new Set(keys).size, keys.length, `${form.formType} has duplicate box keys`);
    assert.ok(keys.includes(form.defaultBox), `${form.formType} default box is not a real box`);
    assert.equal(form.boxes.filter((b) => b.isWithholding).length, 1, `${form.formType} withholding box count`);
  }
});

test("an unknown form is refused rather than defaulted", () => {
  assert.throws(() => formDefinition("1099-K"), /unknown information return form/);
});
