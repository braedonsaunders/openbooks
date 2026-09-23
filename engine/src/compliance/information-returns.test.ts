import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sum } from "../money/money.ts";
import { db } from "../platform/db.ts";
import {
  allocatePaymentToBoxes,
  allocateProportionally,
  canFurnishRecipientCopies,
  filedBoxAmounts,
  filedTotal,
  formDefinition,
  formDefinitionForYear,
  INFORMATION_RETURN_FORMS,
  InformationReturnError,
  recipientExceptions,
  resolveInformationReturnCurrency,
  statutoryFilingThreshold,
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

test("fishing boat proceeds file at any amount", () => {
  // IRS Specific Instructions for Form 1099-MISC: "Any fishing boat proceeds
  // received (box 5)" — unlike most boxes there is no dollar threshold, so a
  // $400 boat-proceeds recipient must file even under a $600 default.
  const boat = summarizeRecipient({
    form: MISC,
    payments: [
      payment({
        cash: "400.0000",
        bills: [{ documentId: "b", applied: "400.0000", lines: [{ accountId: "boat", weight: "400.0000" }] }],
      }),
    ],
    boxByAccount: new Map([["boat", "misc5"]]),
    defaultBox: "misc3",
    filingThreshold: "600",
  });
  assert.equal(boat.belowThreshold, false);
});

test("the general threshold is $600 before 2026 and $2,000 from 2026", () => {
  // OBBBA §70433 (payments made after 31 Dec 2025). Prior-year filings and
  // corrections must keep judging the law that was in force then.
  assert.equal(statutoryFilingThreshold("1099-NEC", 2025), "600");
  assert.equal(statutoryFilingThreshold("1099-MISC", 2025), "600");
  assert.equal(statutoryFilingThreshold("1099-NEC", 2026), "2000");
  assert.equal(statutoryFilingThreshold("1099-MISC", 2026), "2000");
  assert.equal(statutoryFilingThreshold("1099-NEC", 2027), "2000");
  // Canada is untouched by the US reform.
  assert.equal(statutoryFilingThreshold("T4A", 2025), "500");
  assert.equal(statutoryFilingThreshold("T4A", 2026), "500");
});

test("the 2026 catalogue moves the general boxes but keeps the carve-outs", () => {
  const misc2026 = formDefinitionForYear("1099-MISC", 2026);
  const thresholdOf = (key: string) => misc2026.boxes.find((b) => b.key === key)?.threshold;
  assert.equal(misc2026.defaultThreshold, "2000");
  for (const key of ["misc1", "misc3", "misc6", "misc9", "misc11"]) {
    assert.equal(thresholdOf(key), "2000", `${key} should follow the general threshold`);
  }
  // Statutory carve-outs: attorney gross proceeds stay at $600, royalties and
  // substitute payments at $10, boat proceeds and withholding at any amount.
  assert.equal(thresholdOf("misc10"), "600");
  assert.equal(thresholdOf("misc2"), "10");
  assert.equal(thresholdOf("misc8"), "10");
  assert.equal(thresholdOf("misc5"), "0.01");
  assert.equal(thresholdOf("misc4"), "0.01");
  const nec2026 = formDefinitionForYear("1099-NEC", 2026);
  assert.equal(nec2026.boxes.find((b) => b.key === "nec1")?.threshold, "2000");
  assert.equal(nec2026.boxes.find((b) => b.key === "nec4")?.threshold, "0.01");
  // 2025 catalogues are the old law, untouched.
  assert.equal(formDefinitionForYear("1099-NEC", 2025).defaultThreshold, "600");
  assert.equal(
    formDefinitionForYear("1099-MISC", 2025).boxes.find((b) => b.key === "misc1")?.threshold,
    "600",
  );
});

test("a $1,500 NEC recipient files for 2025 but not for 2026", () => {
  const paid = (form: typeof NEC) =>
    summarizeRecipient({
      form,
      payments: [payment({ cash: "1500.0000" })],
      boxByAccount: new Map([["acct-sub", "nec1"]]),
      defaultBox: "nec1",
      filingThreshold: form.defaultThreshold,
    });
  assert.equal(paid(formDefinitionForYear("1099-NEC", 2025)).belowThreshold, false);
  assert.equal(paid(formDefinitionForYear("1099-NEC", 2026)).belowThreshold, true);
});

test("a $1,500 rents recipient files for 2025 but not for 2026", () => {
  // The per-box threshold moves too: $1,500 of box-1 rents must not clear on
  // its own under 2026 law even though the old $600 box threshold would fire.
  const paid = (form: typeof MISC) =>
    summarizeRecipient({
      form,
      payments: [
        payment({
          cash: "1500.0000",
          bills: [{ documentId: "b", applied: "1500.0000", lines: [{ accountId: "rent", weight: "1500.0000" }] }],
        }),
      ],
      boxByAccount: new Map([["rent", "misc1"]]),
      defaultBox: "misc3",
      filingThreshold: form.defaultThreshold,
    });
  assert.equal(paid(formDefinitionForYear("1099-MISC", 2025)).belowThreshold, false);
  assert.equal(paid(formDefinitionForYear("1099-MISC", 2026)).belowThreshold, true);
});

test("a $700 attorney-gross-proceeds recipient still files for 2026", () => {
  const paid = summarizeRecipient({
    form: formDefinitionForYear("1099-MISC", 2026),
    payments: [
      payment({
        cash: "700.0000",
        bills: [{ documentId: "b", applied: "700.0000", lines: [{ accountId: "legal", weight: "700.0000" }] }],
      }),
    ],
    boxByAccount: new Map([["legal", "misc10"]]),
    defaultBox: "misc3",
    filingThreshold: formDefinitionForYear("1099-MISC", 2026).defaultThreshold,
  });
  assert.equal(paid.belowThreshold, false);
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

test("every IRS-listed corporate box suppresses the corporation query", () => {
  // IRS "Reportable payments to corporations" on Form 1099-MISC: box 11 (fish
  // for resale), box 6 (medical), box 8 (substitute payments), box 10
  // (attorney gross proceeds). Each must file quietly for a corporation.
  for (const box of ["misc6", "misc8", "misc10", "misc11"]) {
    assert.deepEqual(
      recipientExceptions({
        profile: profile({ taxClassification: "c_corp", resolvedForm: "1099-MISC" }),
        amounts: amounts("5000", { [box]: "5000" }),
        form: MISC,
        belowThreshold: false,
        filingThreshold: "600",
        unmappedAccountNames: [],
      }),
      [],
      `${box} is reportable for a corporation and must not raise corporation_flagged`,
    );
  }
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
    new URL("../../../web/app/api/compliance/information-returns/[id]/copies/route.ts", import.meta.url),
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

// --- filing currency -------------------------------------------------------

/** Queue-backed executor: each execute answers the next canned row set. */
function stubRunner(rowSets: Record<string, unknown>[][]) {
  const queue = [...rowSets];
  return {
    execute: (async () => ({ rows: queue.shift() ?? [] })) as unknown as Pick<
      typeof db,
      "execute"
    >["execute"],
  };
}

test("a subsidiary filing resolves that subsidiary's functional currency", async () => {
  const currency = await resolveInformationReturnCurrency({
    orgId: "org-1",
    subsidiaryId: "sub-eur",
    runner: stubRunner([[{ base_currency: "EUR" }]]),
  });
  assert.equal(currency, "EUR");
});

test("a filing for an unknown subsidiary is refused, not root-scoped", async () => {
  await assert.rejects(
    resolveInformationReturnCurrency({ orgId: "org-1", subsidiaryId: "sub-nope", runner: stubRunner([[]]) }),
    (error: unknown) => error instanceof InformationReturnError && error.status === 404,
  );
});

test("an org-wide filing in one functional currency resolves it", async () => {
  const currency = await resolveInformationReturnCurrency({
    orgId: "org-1",
    runner: stubRunner([[{ base_currency: "CAD" }]]),
  });
  assert.equal(currency, "CAD");
});

test("an org-wide filing across unlike currencies is refused with the per-subsidiary remedy", async () => {
  await assert.rejects(
    resolveInformationReturnCurrency({
      orgId: "org-1",
      runner: stubRunner([[{ base_currency: "USD" }, { base_currency: "EUR" }]]),
    }),
    (error: unknown) =>
      error instanceof InformationReturnError &&
      /spans functional currencies \(EUR and USD\)/.test(error.message) &&
      /one filing per subsidiary/.test(error.message),
  );
});

test("an org with no active filer falls back to the org base, never a guess", async () => {
  const currency = await resolveInformationReturnCurrency({
    orgId: "org-1",
    runner: stubRunner([[], [{ base_currency: "USD" }]]),
  });
  assert.equal(currency, "USD");
  await assert.rejects(
    resolveInformationReturnCurrency({ orgId: "org-1", runner: stubRunner([[], []]) }),
    /no base currency/,
  );
});
