import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaxFilingSnapshot,
  prepareTaxFiling,
  sortTaxFilingAdjustments,
  TAX_FILING_SNAPSHOT_VERSION,
  type TaxFilingAdjustment,
} from "./filing.ts";
import type { TaxReturnResult } from "./return.ts";

const RETURN_WITH_EDITABLE_BOXES: TaxReturnResult = {
  formCode: "CA_GST34",
  formName: "GST34",
  from: "2026-01-01",
  to: "2026-03-31",
  submissionChannel: "portal_manual",
  watermark: null,
  registrationNumber: null,
  boxes: [
    {
      lineCode: "9",
      label: "Adjustment 9",
      value: "0.0000",
      computed: false,
      editable: true,
      pdfField: null,
    },
    {
      lineCode: "10",
      label: "Adjustment 10",
      value: "0.0000",
      computed: false,
      editable: true,
      pdfField: null,
    },
  ],
  functionalCurrency: "CAD",
  subsidiaryIds: [],
  registrationId: null,
  translation: null,
};

const SUB_A = "11111111-1111-4111-8111-111111111111";
const SUB_B = "22222222-2222-4222-8222-222222222222";

function identifiedReturn(): TaxReturnResult {
  return {
    ...RETURN_WITH_EDITABLE_BOXES,
    boxes: RETURN_WITH_EDITABLE_BOXES.boxes.map((box) => ({ ...box })),
    registrationNumber: "123456789RT0001",
    registrationId: "33333333-3333-4333-8333-333333333333",
    functionalCurrency: "CAD",
    subsidiaryIds: [SUB_B, SUB_A],
    translation: {
      presentationCurrency: "USD",
      rateType: "spot",
      rateDate: "2026-03-31",
      entities: [
        {
          subsidiaryId: SUB_B,
          name: "US Ops",
          currency: "USD",
          fxRate: "1.0000000000",
          rateAsOf: "2026-03-31",
          boxes: [],
        },
        {
          subsidiaryId: SUB_A,
          name: "Main Co",
          currency: "CAD",
          fxRate: "0.7400000000",
          rateAsOf: "2026-03-31",
          boxes: [],
        },
      ],
    },
  };
}

function adjustmentsWithKeyOrder(order: readonly string[]): Record<string, string> {
  const values = { "9": "7.00", "10": "5.00" };
  // Numeric-looking property names normally have ECMAScript's numeric
  // enumeration order. The proxy models the distinct order a JSONB driver
  // can expose and keeps this regression red against the old JSON.stringify
  // fingerprint while retaining the exact statutory box codes.
  return new Proxy(values, { ownKeys: () => [...order] });
}

test("tax filing fingerprints survive jsonb reordering of mixed-length adjustment keys", () => {
  // Prepare normalizes user input before writing JSONB, while mark-filed gets
  // the object back in the driver's JSONB key order. These are the same
  // adjustments and must therefore reproduce the same source fingerprint.
  const prepared = buildTaxFilingSnapshot(
    RETURN_WITH_EDITABLE_BOXES,
    adjustmentsWithKeyOrder(["10", "9"]),
    2,
  );
  const readBack = buildTaxFilingSnapshot(
    RETURN_WITH_EDITABLE_BOXES,
    adjustmentsWithKeyOrder(["9", "10"]),
    2,
  );

  assert.equal(prepared.snapshotHash, readBack.snapshotHash);
});

test("tax filing fingerprints still reject changed adjustment values", () => {
  const prepared = buildTaxFilingSnapshot(
    RETURN_WITH_EDITABLE_BOXES,
    {
      "10": "5.00",
      "9": "7.00",
    },
    2,
  );
  const changed = buildTaxFilingSnapshot(
    RETURN_WITH_EDITABLE_BOXES,
    {
      "9": "7.01",
      "10": "5.00",
    },
    2,
  );

  assert.notEqual(prepared.snapshotHash, changed.snapshotHash);
});

test("new filings fingerprint at snapshot version 3", () => {
  assert.equal(TAX_FILING_SNAPSHOT_VERSION, 3);
  const { snapshot } = buildTaxFilingSnapshot(identifiedReturn(), []);
  assert.equal(snapshot.version, 3);
});

// Every identity/posture field must trip the mark-filed staleness check on
// its own: a registration change, a currency change or a scope change passes
// no filing when the box values still match.
test("each identity field change trips the v2 fingerprint", () => {
  const adjustments = {};
  const baseline = buildTaxFilingSnapshot(identifiedReturn(), adjustments, 2).snapshotHash;
  const variants: [string, (result: TaxReturnResult) => void][] = [
    [
      "registrationNumber",
      (r) => {
        r.registrationNumber = "987654321RT0009";
      },
    ],
    [
      "registrationId",
      (r) => {
        r.registrationId = "44444444-4444-4444-8444-444444444444";
      },
    ],
    [
      "functionalCurrency",
      (r) => {
        r.functionalCurrency = "USD";
      },
    ],
    [
      "subsidiaryIds",
      (r) => {
        r.subsidiaryIds = [SUB_A];
      },
    ],
    [
      "translation rate",
      (r) => {
        r.translation = {
          ...r.translation!,
          entities: r.translation!.entities.map((e) =>
            e.subsidiaryId === SUB_A ? { ...e, fxRate: "0.7500000000" } : e,
          ),
        };
      },
    ],
    [
      "translation presentation",
      (r) => {
        r.translation = { ...r.translation!, presentationCurrency: "EUR" };
      },
    ],
    [
      "translation dropped",
      (r) => {
        r.translation = null;
        r.functionalCurrency = "CAD";
      },
    ],
  ];
  for (const [name, mutate] of variants) {
    const changed = identifiedReturn();
    mutate(changed);
    assert.notEqual(
      buildTaxFilingSnapshot(changed, adjustments, 2).snapshotHash,
      baseline,
      `${name} must change the v2 fingerprint`,
    );
  }
});

test("v2 fingerprints ignore scope and translation ordering", () => {
  const adjustments = {};
  const forward = buildTaxFilingSnapshot(identifiedReturn(), adjustments, 2).snapshotHash;
  const reordered: TaxReturnResult = {
    ...identifiedReturn(),
    subsidiaryIds: [SUB_A, SUB_B],
    translation: {
      ...identifiedReturn().translation!,
      entities: [...identifiedReturn().translation!.entities].reverse(),
    },
  };
  assert.equal(buildTaxFilingSnapshot(reordered, adjustments, 2).snapshotHash, forward);
});

test("v1 reproduces the pre-identity fingerprint and ignores identity drift", () => {
  // A filing prepared before the identity columns existed verifies exactly as
  // prepared: its boxes-only hash must be reproducible, and identity changes
  // must NOT trip it (documented limitation — only v2 filings verify
  // posture). The golden hash below pins the v1 byte shape so no refactor
  // can silently strand every historical filing as stale.
  const v1 = buildTaxFilingSnapshot(identifiedReturn(), {}, 2);
  const legacy = buildTaxFilingSnapshot(identifiedReturn(), {}, 1);
  assert.equal(
    legacy.snapshotHash,
    "7b850b33b0cb948ee7c483ee0af5e19baac09e77986c86f1177bbaf5b808db1b",
    "v1 byte shape is the comparability contract for every pre-identity filing",
  );
  assert.deepEqual(Object.keys(legacy.snapshot).sort(), [
    "adjustments",
    "boxes",
    "formCode",
    "formName",
    "from",
    "submissionChannel",
    "to",
  ]);
  assert.notEqual(v1.snapshotHash, legacy.snapshotHash);

  const renumbered = identifiedReturn();
  renumbered.registrationNumber = "987654321RT0009";
  renumbered.registrationId = "44444444-4444-4444-8444-444444444444";
  renumbered.functionalCurrency = "USD";
  renumbered.subsidiaryIds = [SUB_A];
  renumbered.translation = null;
  assert.equal(
    buildTaxFilingSnapshot(renumbered, {}, 1).snapshotHash,
    legacy.snapshotHash,
    "v1 must verify boxes only",
  );
});

const ENTRY_PRE_CONVERSION: TaxFilingAdjustment = {
  lineCode: "104",
  amount: "3018.8400",
  reason: "Jan–Aug 2025 pre-conversion activity per prior system",
  enteredBy: "user-1",
  enteredAt: "2026-10-11T10:00:00.000Z",
};
const ENTRY_ITC: TaxFilingAdjustment = {
  lineCode: "107",
  amount: "10.0000",
  reason: "ITC recovered on a supplier credit note",
  enteredBy: "user-1",
  enteredAt: "2026-10-11T10:00:00.000Z",
};

test("v3 fingerprints do not depend on the order the entries were recorded", () => {
  const forward = buildTaxFilingSnapshot(identifiedReturn(), [
    ENTRY_PRE_CONVERSION,
    ENTRY_ITC,
  ]).snapshotHash;
  const reversed = buildTaxFilingSnapshot(identifiedReturn(), [
    ENTRY_ITC,
    ENTRY_PRE_CONVERSION,
  ]).snapshotHash;
  assert.equal(forward, reversed);
});

test("v3 fingerprints the reason, author, time and amount of every entry", () => {
  const baseline = buildTaxFilingSnapshot(identifiedReturn(), [ENTRY_PRE_CONVERSION]).snapshotHash;
  const variants: Partial<TaxFilingAdjustment>[] = [
    { reason: "Different reason" },
    { enteredBy: "user-2" },
    { enteredAt: "2026-10-12T10:00:00.000Z" },
    { amount: "3018.8500" },
  ];
  for (const variant of variants) {
    assert.notEqual(
      buildTaxFilingSnapshot(identifiedReturn(), [{ ...ENTRY_PRE_CONVERSION, ...variant }])
        .snapshotHash,
      baseline,
      `${Object.keys(variant)[0]} must change the v3 fingerprint`,
    );
  }
});

test("each snapshot version takes the adjustment shape it recorded", () => {
  assert.throws(
    () => buildTaxFilingSnapshot(identifiedReturn(), [ENTRY_PRE_CONVERSION], 2),
    /amounts per line/,
  );
  assert.throws(() => buildTaxFilingSnapshot(identifiedReturn(), {}, 3), /governed entries/);
});

test("the v3 snapshot stores its entries in a deterministic order", () => {
  const { snapshot } = buildTaxFilingSnapshot(identifiedReturn(), [
    ENTRY_ITC,
    ENTRY_PRE_CONVERSION,
  ]);
  assert.deepEqual(snapshot.adjustments, [ENTRY_PRE_CONVERSION, ENTRY_ITC]);
  assert.deepEqual(sortTaxFilingAdjustments([ENTRY_ITC, ENTRY_PRE_CONVERSION]), [
    ENTRY_PRE_CONVERSION,
    ENTRY_ITC,
  ]);
});

test("v3 ordering includes the author when other entry fields match", () => {
  const secondAuthor = { ...ENTRY_PRE_CONVERSION, enteredBy: "user-2" };
  assert.equal(
    buildTaxFilingSnapshot(identifiedReturn(), [ENTRY_PRE_CONVERSION, secondAuthor]).snapshotHash,
    buildTaxFilingSnapshot(identifiedReturn(), [secondAuthor, ENTRY_PRE_CONVERSION]).snapshotHash,
  );
});

test("a snapshot does not retain mutable references to its source evidence", () => {
  const source = identifiedReturn();
  source.translation!.entities[0]!.boxes = [{ ...source.boxes[0]! }];
  const entries = [{ ...ENTRY_PRE_CONVERSION }];
  const frozen = buildTaxFilingSnapshot(source, entries);
  const expected = JSON.stringify(frozen.snapshot);
  entries[0]!.reason = "Replaced reason";
  source.translation!.entities[0]!.boxes[0]!.value = "10.0000";
  source.boxes[0]!.value = "99.0000";
  assert.equal(JSON.stringify(frozen.snapshot), expected);
  const amountMap = { "9": "1.0000" };
  const legacy = buildTaxFilingSnapshot(identifiedReturn(), amountMap, 2);
  amountMap["9"] = "2.0000";
  assert.deepEqual(legacy.snapshot.adjustments, { "9": "1.0000" });
});

test("prepare refuses a return with adjustment amounts without matching evidence", async () => {
  const result = {
    ...RETURN_WITH_EDITABLE_BOXES,
    boxes: [{ ...RETURN_WITH_EDITABLE_BOXES.boxes[0]!, value: "1.0000" }],
  };
  await assert.rejects(
    () => prepareTaxFiling("org-1", "user-1", result, []),
    /without matching adjustment evidence/,
  );
  await assert.rejects(
    () =>
      prepareTaxFiling("org-1", "user-1", result, [
        { lineCode: "9", amount: "2", reason: "Prior-system activity" },
      ]),
    /no longer matches the entered adjustments/,
  );
});

test("prepare refuses adjustments on computed or input-backed boxes even when flagged editable", async () => {
  for (const extra of [{ computed: true }, { inputKey: "income-tax.provision" }]) {
    const result = {
      ...RETURN_WITH_EDITABLE_BOXES,
      boxes: [{ ...RETURN_WITH_EDITABLE_BOXES.boxes[0]!, value: "1.0000", ...extra }],
    };
    await assert.rejects(
      () =>
        prepareTaxFiling("org-1", "user-1", result, [
          { lineCode: "9", amount: "1", reason: "Prior-system activity" },
        ]),
      /not an adjustment line/,
    );
  }
});
