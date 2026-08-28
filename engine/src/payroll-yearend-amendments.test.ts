import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { sealSecret } from "./secrets.ts";
import { PayrollError } from "./payroll-error.ts";
import {
  registerPayrollFilings,
  unregisterPayrollFilings,
  yearEndFiling,
  type PayrollFilingCorrectionRow,
} from "./payroll-filing-registry.ts";
import { renderT4Xml, t4SlipFromReported } from "./payroll-t4xml.ts";
import { build941X, buildW2c } from "./payroll-w2c.ts";
import {
  diffReported,
  filingArtifact,
  filingCorrectionSlip,
  filingLifecycle,
  filingSubmissions,
  recordFilingIssue,
} from "./payroll-yearend-amendments.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The AMENDED / CANCELLED filing lifecycle.
 *
 * Three things are under test and they are different:
 *
 *   1. the GENERIC lifecycle — snapshot, delta, supersession, and the
 *      refusals that stop a correction being filed for the wrong reason;
 *   2. the PACK-DECLARED artifacts, byte for byte, against the agencies'
 *      published mechanics (CRA report-type codes; IRS W-2c and 941-X);
 *   3. the doctrine that a pack which cannot produce a correct artifact
 *      REFUSES BY NAME rather than emitting an approximation.
 *
 * The conformance goldens (T4127, Pub 15-T, TP-1015) are untouched by all of
 * this: nothing here changes a withholding calculation, and the year-end
 * builders are read-only projections of committed stubs.
 */

/* ------------------------------------------------------------------ */
/* 1. The delta is the point                                          */
/* ------------------------------------------------------------------ */

test("the delta names exactly the fields that moved, in the form's own words", () => {
  const changes = diffReported(
    {
      fields: [
        { code: null, label: "Province of employment (10)", value: "ON" },
        { code: "14", label: "Employment income", value: "52000.00" },
        { code: "22", label: "Income tax deducted", value: "9100.75" },
        { code: "44", label: "Union dues", value: "600.00" },
      ],
      confidential: [],
    },
    {
      fields: [
        { code: null, label: "Province of employment (10)", value: "BC" },
        { code: "14", label: "Employment income", value: "54500.00" },
        { code: "22", label: "Income tax deducted", value: "9100.75" },
        { code: "44", label: "Union dues", value: "600.00" },
      ],
      confidential: [],
    },
  );
  assert.deepEqual(changes, [
    {
      code: null, label: "Province of employment (10)",
      previous: "ON", current: "BC", redacted: false,
    },
    { code: "14", label: "Employment income", previous: "52000.00", current: "54500.00", redacted: false },
  ]);
});

test("a box that started or stopped being reported is a change, not an omission", () => {
  const changes = diffReported(
    { fields: [{ code: "55", label: "Employee's PPIP premiums", value: "412.00" }], confidential: [] },
    { fields: [{ code: "56", label: "PPIP insurable earnings", value: "54500.00" }], confidential: [] },
  );
  assert.deepEqual(changes, [
    { code: "56", label: "PPIP insurable earnings", previous: null, current: "54500.00", redacted: false },
    { code: "55", label: "Employee's PPIP premiums", previous: "412.00", current: null, redacted: false },
  ]);
});

test("a confidential identifier reports as CHANGED with both values withheld", () => {
  // A wrong SIN is one of the commonest reasons to amend, and the operator
  // must see that it moved. The number itself is never in the snapshot, so
  // the comparison is on a keyed fingerprint and the change carries no values.
  const changes = diffReported(
    { fields: [], confidential: [{ label: "Social insurance number", fingerprint: "aaaa" }] },
    { fields: [], confidential: [{ label: "Social insurance number", fingerprint: "bbbb" }] },
  );
  assert.deepEqual(changes, [
    { code: null, label: "Social insurance number", previous: null, current: null, redacted: true },
  ]);
  // An unchanged identifier is silent.
  assert.deepEqual(
    diffReported(
      { fields: [], confidential: [{ label: "Social insurance number", fingerprint: "aaaa" }] },
      { fields: [], confidential: [{ label: "Social insurance number", fingerprint: "aaaa" }] },
    ),
    [],
  );
});

/* ------------------------------------------------------------------ */
/* 2. Which packs amend which filings — the declaration IS the answer  */
/* ------------------------------------------------------------------ */

test("every built-in filing declares how it is corrected — or why it is not", () => {
  const t4 = yearEndFiling("CA", "t4").amendment;
  assert.equal(t4.supported, true);
  assert.ok(t4.supported);
  // The CRA re-files the SAME form under a report-type code.
  assert.equal(t4.vehicle, "same_form");
  assert.deepEqual([...t4.revisions], ["amended", "cancelled"]);
  assert.ok(t4.download, "the CRA correction is transmitted, not printed");

  const w2 = yearEndFiling("US", "w2").amendment;
  assert.ok(w2.supported);
  // The IRS uses a WHOLLY SEPARATE correction form.
  assert.equal(w2.vehicle, "correction_form");
  assert.equal(w2.formLabel, "Form W-2c");
  assert.deepEqual([...w2.revisions], ["amended", "cancelled"]);
  assert.match(w2.downloadRefusal!, /EFW2C/, "the absent e-file is named");

  const q = yearEndFiling("US", "941").amendment;
  assert.ok(q.supported);
  assert.equal(q.formLabel, "Form 941-X");
  // A filed quarter cannot be withdrawn — the pack says so by declaring only
  // `amended`, and the generic layer needs no US-specific rule to enforce it.
  assert.deepEqual([...q.revisions], ["amended"]);

  // Québec REFUSES: the correction format is partner-gated.
  const rl1 = yearEndFiling("CA", "rl1").amendment;
  assert.equal(rl1.supported, false);
  assert.ok(!rl1.supported);
  assert.match(rl1.refusal, /IN-800/);
  assert.match(rl1.refusal, /SECOND original/);

  // The ROE refuses for a different, equally specific reason.
  const roe = yearEndFiling("CA", "roe").amendment;
  assert.ok(!roe.supported);
  assert.match(roe.refusal, /serial number/);
});

test("a filing that declares no amendment support is refused at registration", async () => {
  const { registerPayrollFilings, unregisterPayrollFilings } =
    await import("./payroll-filing-registry.ts");
  const { PayrollPackError } = await import("./payroll/packs.ts");
  const population = async () => ({ rowKey: "id", columns: [], rows: [] });
  const base = { country: "ZQ", programTypes: [] as never[] };

  assert.throws(
    () => registerPayrollFilings({
      ...base,
      yearEnd: [{ key: "x", label: "X", cadence: "annual", population }],
    } as never),
    (error: Error) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match(error.message, /declares no amendment support/);
      return true;
    },
  );
  assert.throws(
    () => registerPayrollFilings({
      ...base,
      yearEnd: [{
        key: "x", label: "X", cadence: "annual", population,
        amendment: { supported: false, refusal: "  " },
      }],
    } as never),
    /no amendment support and no reason/,
  );
  assert.throws(
    () => registerPayrollFilings({
      ...base,
      yearEnd: [{
        key: "x", label: "X", cadence: "annual", population,
        amendment: { supported: true, revisions: [], vehicle: "same_form" },
      }],
    } as never),
    /names no revisions/,
  );
  assert.throws(
    () => registerPayrollFilings({
      ...base,
      yearEnd: [{
        key: "x", label: "X", cadence: "annual", population,
        amendment: { supported: true, revisions: ["amended"], vehicle: "correction_form" },
      }],
    } as never),
    /does not name it/,
  );
  assert.throws(
    () => registerPayrollFilings({
      ...base,
      yearEnd: [{
        key: "x", label: "X", cadence: "annual", population,
        amendment: { supported: true, revisions: ["amended"], vehicle: "same_form" },
      }],
    } as never),
    /neither a correction file nor a reason/,
  );
  unregisterPayrollFilings("ZQ");
});

/* ------------------------------------------------------------------ */
/* 3. Golden artifacts, byte for byte                                  */
/* ------------------------------------------------------------------ */

const TRANSMITTER = {
  bn: "999999999RP0001",
  transmitterNumber: "MM555555",
  name: "Acme Ltd",
  contactName: "Pat Payroll",
  contactEmail: "pat@acme.test",
  contactPhone: "5555550100",
};

const GOLDEN_SLIP = {
  employeePartyId: "11111111-1111-4111-8111-111111111111",
  employeeName: "Grace Hopper",
  province: "ON",
  isQuebec: false,
  filingAccountId: "22222222-2222-4222-8222-222222222222",
  box14EmploymentIncome: "54500.00",
  box16Cpp: "3200.50",
  box16aCpp2: "188.00",
  box18Ei: "834.20",
  box22IncomeTax: "9100.75",
  box24EiInsurable: "54500.00",
  box26CppPensionable: "54500.00",
  box44UnionDues: "600.00",
  box55Qpip: "0",
  box56QpipInsurable: "0",
  stubCount: 26,
  sin: "046454286",
};

const GOLDEN_SUMMARY = {
  slips: 1,
  employmentIncome: "54500.00",
  employeeCpp: "3200.50",
  employeeCpp2: "188.00",
  employerCpp: "3388.50",
  employeeEi: "834.20",
  employerEi: "1167.88",
  incomeTax: "9100.75",
  remitted: "0",
};

const goldenT4 = (reportTypeCode: "O" | "A" | "C") =>
  renderT4Xml({
    orgId: "abcdef12-0000-4000-8000-000000000000",
    taxYear: 2026,
    transmitter: TRANSMITTER,
    returns: [{
      filingAccount: {
        id: GOLDEN_SLIP.filingAccountId,
        accountNumber: "123456789RP0002",
        name: "Field division",
        remitterType: "regular",
      },
      slips: [GOLDEN_SLIP],
      summary: GOLDEN_SUMMARY,
    }],
    reportTypeCode,
  });

/**
 * CRA T4 Internet File Transfer, AMENDED submission.
 *
 * Cited to the CRA's electronic filing specification for the T4 return: the
 * report-type code `rpt_tcd` on the T619 transmittal and `RPT_TCD` on every
 * T4Slip and the T4Summary carry O (original), A (amended) or C (cancelled),
 * and all three must agree within one submission. An amended submission
 * carries only the slips being restated, and its summary totals those slips.
 */
const T4_AMENDED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Submission xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <T619>
  <sbmt_ref_id>T4-2026-A-abcdef12</sbmt_ref_id>
  <rpt_tcd>A</rpt_tcd>
  <trnmtr_nbr>MM555555</trnmtr_nbr>
  <trnmtr_tcd>1</trnmtr_tcd>
  <summ_cnt>1</summ_cnt>
  <lang_cd>E</lang_cd>
  <TRNMTR_NM><l1_nm>Acme Ltd</l1_nm></TRNMTR_NM>
  <CNTC><cntc_nm>Pat Payroll</cntc_nm><cntc_area_cd></cntc_area_cd><cntc_phn_nbr>5555550100</cntc_phn_nbr><cntc_email_area>pat@acme.test</cntc_email_area></CNTC>
 </T619>
 <Return>
 <T4>
  <T4Slip>
   <EMPE_NM><snm>Hopper</snm><gvn_nm>Grace</gvn_nm></EMPE_NM>
   <SIN>046454286</SIN>
   <BN>123456789RP0002</BN>
   <EMPT_PROV_CD>ON</EMPT_PROV_CD>
   <RPT_TCD>A</RPT_TCD>
   <EMPT_INC_AMT>54500.00</EMPT_INC_AMT>
   <CPP_CNTRB_AMT>3200.50</CPP_CNTRB_AMT>
   <EMPE_CPP2_AMT>188.00</EMPE_CPP2_AMT>
   <EIP_AMT>834.20</EIP_AMT>
   <ITX_DDCT_AMT>9100.75</ITX_DDCT_AMT>
   <EI_INSU_ERN_AMT>54500.00</EI_INSU_ERN_AMT>
   <CPP_QPP_ERN_AMT>54500.00</CPP_QPP_ERN_AMT>
   <UNN_DUES_AMT>600.00</UNN_DUES_AMT>
  </T4Slip>
  <T4Summary>
   <bn>123456789RP0002</bn>
   <tx_yr>2026</tx_yr>
   <slp_cnt>1</slp_cnt>
   <RPT_TCD>A</RPT_TCD>
   <TOT_EMPT_INC_AMT>54500.00</TOT_EMPT_INC_AMT>
   <TOT_EMPE_CPP_AMT>3200.50</TOT_EMPE_CPP_AMT>
   <TOT_EMPE_CPP2_AMT>188.00</TOT_EMPE_CPP2_AMT>
   <TOT_EMPR_CPP_AMT>3388.50</TOT_EMPR_CPP_AMT>
   <TOT_EMPE_EIP_AMT>834.20</TOT_EMPE_EIP_AMT>
   <TOT_EMPR_EIP_AMT>1167.88</TOT_EMPR_EIP_AMT>
   <TOT_ITX_DDCT_AMT>9100.75</TOT_ITX_DDCT_AMT>
  </T4Summary>
 </T4>
 </Return>
</Submission>
`;

/**
 * CRA T4, CANCELLED submission. Per the CRA's instruction a cancelled slip
 * carries the SAME information as the original — the employer is declaring
 * that the slip should never have existed, not that its figures moved — so
 * only the report-type code differs from the return that was filed.
 */
const T4_CANCELLED_XML = T4_AMENDED_XML
  .replace("<sbmt_ref_id>T4-2026-A-abcdef12</sbmt_ref_id>", "<sbmt_ref_id>T4-2026-C-abcdef12</sbmt_ref_id>")
  .replace("<rpt_tcd>A</rpt_tcd>", "<rpt_tcd>C</rpt_tcd>")
  .replace("<RPT_TCD>A</RPT_TCD>\n   <EMPT_INC_AMT>", "<RPT_TCD>C</RPT_TCD>\n   <EMPT_INC_AMT>")
  .replace("<slp_cnt>1</slp_cnt>\n   <RPT_TCD>A</RPT_TCD>", "<slp_cnt>1</slp_cnt>\n   <RPT_TCD>C</RPT_TCD>");

test("the amended T4 XML is byte-identical to the CRA-coded golden", () => {
  assert.equal(goldenT4("A"), T4_AMENDED_XML);
});

test("the cancelled T4 XML is byte-identical to the CRA-coded golden", () => {
  assert.equal(goldenT4("C"), T4_CANCELLED_XML);
});

test("an ORIGINAL T4 submission is unchanged, byte for byte", () => {
  // The whole amendment slice must not move the original filing by one byte.
  const original = goldenT4("O");
  assert.equal(
    original,
    T4_AMENDED_XML
      .replace("<sbmt_ref_id>T4-2026-A-abcdef12</sbmt_ref_id>", "<sbmt_ref_id>T4-2026-abcdef12</sbmt_ref_id>")
      .replaceAll("<rpt_tcd>A</rpt_tcd>", "<rpt_tcd>O</rpt_tcd>")
      .replaceAll("<RPT_TCD>A</RPT_TCD>", "<RPT_TCD>O</RPT_TCD>"),
  );
  // And the default is the original — no caller has to opt in to it.
  assert.equal(
    renderT4Xml({
      orgId: "abcdef12-0000-4000-8000-000000000000",
      taxYear: 2026,
      transmitter: TRANSMITTER,
      returns: [{
        filingAccount: {
          id: GOLDEN_SLIP.filingAccountId, accountNumber: "123456789RP0002",
          name: "Field division", remitterType: "regular",
        },
        slips: [GOLDEN_SLIP],
        summary: GOLDEN_SUMMARY,
      }],
    }),
    original,
  );
});

test("a snapshot round-trips back into the slip a cancellation must file", () => {
  // The cancellation path rebuilds the slip from what was REPORTED, because
  // the ledger no longer produces it. This is the inverse of the CA pack's
  // own slip declaration and the two must not drift.
  const rowId = `${GOLDEN_SLIP.employeePartyId}:ON:${GOLDEN_SLIP.filingAccountId}`;
  const reported = {
    fields: [
      { code: null, label: "Employee's name", value: "Grace Hopper" },
      { code: null, label: "Province of employment (10)", value: "ON" },
      { code: "14", label: "Employment income", value: "54500.00" },
      { code: "16", label: "Employee's CPP contributions", value: "3200.50" },
      { code: "16A", label: "Employee's second CPP contributions", value: "188.00" },
      { code: "18", label: "Employee's EI premiums", value: "834.20" },
      { code: "22", label: "Income tax deducted", value: "9100.75" },
      { code: "24", label: "EI insurable earnings", value: "54500.00" },
      { code: "26", label: "CPP/QPP pensionable earnings", value: "54500.00" },
      { code: "44", label: "Union dues", value: "600.00" },
    ],
  };
  const { sin: _sin, stubCount: _stubCount, ...expected } = GOLDEN_SLIP;
  const { stubCount, ...rebuilt } = t4SlipFromReported(reported, rowId);
  assert.deepEqual(rebuilt, expected);
  // The stub count is provenance, not a T4 box, and the transmittal never
  // prints it — so a rebuilt slip does not pretend to know it.
  assert.equal(stubCount, 0);
});

test("a Québec snapshot round-trips through boxes 17/17A, not 16/16A", () => {
  const rowId = "11111111-1111-4111-8111-111111111111:QC:";
  const slip = t4SlipFromReported({
    fields: [
      { code: null, label: "Employee's name", value: "Jean Tremblay" },
      { code: "14", label: "Employment income", value: "40000.00" },
      { code: "17", label: "Employee's QPP contributions", value: "2400.00" },
      { code: "17A", label: "Employee's second QPP contributions", value: "120.00" },
      { code: "55", label: "Employee's PPIP premiums", value: "197.60" },
      { code: "56", label: "PPIP insurable earnings", value: "40000.00" },
    ],
  }, rowId);
  assert.equal(slip.isQuebec, true);
  assert.equal(slip.box16Cpp, "2400.00");
  assert.equal(slip.box16aCpp2, "120.00");
  assert.equal(slip.box55Qpip, "197.60");
  assert.equal(slip.filingAccountId, null);
});

const W2_CORRECTION: PayrollFilingCorrectionRow = {
  rowId: "11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333",
  label: "Ada Lovelace",
  revision: "amended",
  previously: {
    fields: [
      { code: null, label: "Employee's name", value: "Ada Lovelace" },
      { code: null, label: "State(s) of employment", value: "NY" },
      { code: null, label: "Employer identification number (EIN)", value: "12-3456789" },
      { code: null, label: "Tax year", value: "2026" },
      { code: "1", label: "Wages, tips, other compensation", value: "82000.00" },
      { code: "2", label: "Federal income tax withheld", value: "11400.00" },
      { code: "3", label: "Social security wages", value: "82000.00" },
      { code: "4", label: "Social security tax withheld", value: "5084.00" },
      { code: "5", label: "Medicare wages and tips", value: "82000.00" },
      { code: "6", label: "Medicare tax withheld", value: "1189.00" },
    ],
    confidential: [{ label: "Social security number", fingerprint: "aaaa" }],
  },
  current: {
    formCode: "US_W2",
    formName: "Form W-2 — Wage and Tax Statement",
    formNumber: "Form W-2",
    headerFields: [
      { label: "Employee's name", value: "Ada Lovelace" },
      { label: "State(s) of employment", value: "NY" },
      { label: "Employer identification number (EIN)", value: "12-3456789" },
      { label: "Tax year", value: "2026" },
    ],
    boxes: [
      { code: "1", label: "Wages, tips, other compensation", value: "84500.00" },
      { code: "2", label: "Federal income tax withheld", value: "11400.00" },
      { code: "3", label: "Social security wages", value: "84500.00" },
      { code: "4", label: "Social security tax withheld", value: "5239.00" },
      { code: "5", label: "Medicare wages and tips", value: "84500.00" },
      { code: "6", label: "Medicare tax withheld", value: "1225.25" },
    ],
  },
  changes: [
    { code: "1", label: "Wages, tips, other compensation", previous: "82000.00", current: "84500.00", redacted: false },
    { code: "3", label: "Social security wages", previous: "82000.00", current: "84500.00", redacted: false },
    { code: "4", label: "Social security tax withheld", previous: "5084.00", current: "5239.00", redacted: false },
    { code: "5", label: "Medicare wages and tips", previous: "82000.00", current: "84500.00", redacted: false },
    { code: "6", label: "Medicare tax withheld", previous: "1189.00", current: "1225.25", redacted: false },
    { code: null, label: "Social security number", previous: null, current: null, redacted: true },
  ],
};

/**
 * Form W-2c, Corrected Wage and Tax Statement.
 *
 * Cited to the IRS General Instructions for Forms W-2 and W-3, "Corrections":
 * a filed W-2 is corrected on a SEPARATE form which prints, for each box being
 * corrected, both the previously reported amount and the correct information;
 * boxes (f)/(g) carry the employee's previously reported SSN and name; only
 * the boxes being corrected are completed; the set is transmitted on Form
 * W-3c. Box 2 is absent from this golden precisely because it did not change.
 */
const W2C_GOLDEN = `{
  "formCode": "US_W2C",
  "formName": "Form W-2c — Corrected Wage and Tax Statement",
  "formNumber": "Form W-2c",
  "headerFields": [
    {
      "label": "Employer identification number (EIN) (b)",
      "value": "12-3456789"
    },
    {
      "label": "Tax year of the form being corrected (c)",
      "value": "2026"
    },
    {
      "label": "Form being corrected (c)",
      "value": "W-2"
    },
    {
      "label": "Employee's name (h)",
      "value": "Ada Lovelace"
    },
    {
      "label": "Previously reported — Social security number",
      "value": "changed (enter from the employee's record)"
    }
  ],
  "boxes": [
    {
      "code": "1",
      "label": "Wages, tips, other compensation — previously reported",
      "value": "82000.00"
    },
    {
      "code": "1",
      "label": "Wages, tips, other compensation — correct information",
      "value": "84500.00",
      "emphasis": true
    },
    {
      "code": "3",
      "label": "Social security wages — previously reported",
      "value": "82000.00"
    },
    {
      "code": "3",
      "label": "Social security wages — correct information",
      "value": "84500.00",
      "emphasis": true
    },
    {
      "code": "4",
      "label": "Social security tax withheld — previously reported",
      "value": "5084.00"
    },
    {
      "code": "4",
      "label": "Social security tax withheld — correct information",
      "value": "5239.00",
      "emphasis": true
    },
    {
      "code": "5",
      "label": "Medicare wages and tips — previously reported",
      "value": "82000.00"
    },
    {
      "code": "5",
      "label": "Medicare wages and tips — correct information",
      "value": "84500.00",
      "emphasis": true
    },
    {
      "code": "6",
      "label": "Medicare tax withheld — previously reported",
      "value": "1189.00"
    },
    {
      "code": "6",
      "label": "Medicare tax withheld — correct information",
      "value": "1225.25",
      "emphasis": true
    }
  ],
  "notes": [
    "Only the boxes being corrected are completed, per the Form W-2c instructions; every other box on the original W-2 stands.",
    "File Form W-3c, Transmittal of Corrected Wage and Tax Statements, with the W-2c set, and give the employee their copies.",
    "The SSA EFW2C electronic correction file is not generated — the same gap the original W-2 declares for EFW2. Transmit corrections through SSA Business Services Online, or mail the printed W-2c/W-3c."
  ]
}`;

test("Form W-2c is byte-identical to the IRS-coded golden", () => {
  assert.equal(JSON.stringify(buildW2c(W2_CORRECTION, 2026), null, 2), W2C_GOLDEN);
});

test("a cancelled W-2 corrects every reported amount to nil, and says why", () => {
  const cancelled = buildW2c({ ...W2_CORRECTION, revision: "cancelled" }, 2026);
  const correct = cancelled.boxes.filter((box) => box.label.endsWith("correct information"));
  assert.equal(correct.length, 6, "every reported money box is corrected");
  assert.deepEqual([...new Set(correct.map((box) => box.value))], ["0.00"]);
  assert.ok(
    cancelled.notes!.some((note) => /has no delete transaction/.test(note)),
    "the SSA's absence of a delete transaction is stated, not assumed",
  );
});

test("a W-2c with nothing to correct refuses rather than filing a null correction", () => {
  assert.throws(
    () => buildW2c({ ...W2_CORRECTION, changes: [] }, 2026),
    (error: Error) => {
      assert.ok(error instanceof PayrollError);
      assert.match(error.message, /nothing on this W-2 changed/);
      return true;
    },
  );
});

const Q_CORRECTION: PayrollFilingCorrectionRow = {
  rowId: "33333333-3333-4333-8333-333333333333:2",
  label: "Q2",
  revision: "amended",
  previously: {
    fields: [
      { code: null, label: "Employer identification number (EIN)", value: "12-3456789" },
      { code: null, label: "Report for this quarter", value: "Q2 2026" },
      { code: "2", label: "Wages, tips, and other compensation", value: "205000.00" },
      { code: "3", label: "Federal income tax withheld from wages, tips, and other compensation", value: "28400.00" },
      { code: "5a", label: "Taxable social security wages", value: "205000.00" },
      { code: "5c", label: "Taxable Medicare wages & tips", value: "205000.00" },
      { code: "5e", label: "Total social security and Medicare taxes (employee + employer)", value: "31365.00" },
    ],
    confidential: [],
  },
  current: {
    formCode: "US_941",
    formName: "Form 941 — Employer's Quarterly Federal Tax Return",
    formNumber: "Form 941",
    headerFields: [
      { label: "Employer identification number (EIN)", value: "12-3456789" },
      { label: "Report for this quarter", value: "Q2 2026" },
    ],
    boxes: [],
  },
  changes: [
    { code: "2", label: "Wages, tips, and other compensation", previous: "205000.00", current: "207500.00", redacted: false },
    { code: "5a", label: "Taxable social security wages", previous: "205000.00", current: "207500.00", redacted: false },
    { code: "5e", label: "Total social security and Medicare taxes (employee + employer)", previous: "31365.00", current: "31747.50", redacted: false },
  ],
};

/**
 * Form 941-X, Adjusted Employer's QUARTERLY Federal Tax Return or Claim for
 * Refund. Cited to the IRS Instructions for Form 941-X: the adjustment is
 * reported in three columns — column 1 the total corrected amount, column 2
 * the amount originally reported (or as previously corrected) and column 3
 * the difference, column 1 minus column 2.
 */
const FORM_941X_GOLDEN = `{
  "formCode": "US_941X",
  "formName": "Form 941-X — Adjusted Employer's QUARTERLY Federal Tax Return or Claim for Refund",
  "formNumber": "Form 941-X",
  "headerFields": [
    {
      "label": "Employer identification number (EIN)",
      "value": "12-3456789"
    },
    {
      "label": "Return you are correcting",
      "value": "Q2 2026"
    },
    {
      "label": "Form being corrected",
      "value": "941"
    }
  ],
  "boxes": [
    {
      "code": "2",
      "label": "Wages, tips, and other compensation — column 1, total corrected amount",
      "value": "207500.00"
    },
    {
      "code": "2",
      "label": "Wages, tips, and other compensation — column 2, amount originally reported",
      "value": "205000.00"
    },
    {
      "code": "2",
      "label": "Wages, tips, and other compensation — column 3, difference",
      "value": "2500.00",
      "emphasis": true
    },
    {
      "code": "5a",
      "label": "Taxable social security wages — column 1, total corrected amount",
      "value": "207500.00"
    },
    {
      "code": "5a",
      "label": "Taxable social security wages — column 2, amount originally reported",
      "value": "205000.00"
    },
    {
      "code": "5a",
      "label": "Taxable social security wages — column 3, difference",
      "value": "2500.00",
      "emphasis": true
    },
    {
      "code": "5e",
      "label": "Total social security and Medicare taxes (employee + employer) — column 1, total corrected amount",
      "value": "31747.50"
    },
    {
      "code": "5e",
      "label": "Total social security and Medicare taxes (employee + employer) — column 2, amount originally reported",
      "value": "31365.00"
    },
    {
      "code": "5e",
      "label": "Total social security and Medicare taxes (employee + employer) — column 3, difference",
      "value": "382.50",
      "emphasis": true
    }
  ],
  "notes": [
    "Column 3 is column 1 minus column 2, computed in exact decimal arithmetic from the committed pay stubs — it is never keyed.",
    "Form 941-X uses its own line numbering, which differs from Form 941's; the codes shown here are the Form 941 lines these amounts were computed from and must be transcribed onto the 941-X's corresponding lines.",
    "Form 941-X also requires the correction date, the certification in Part 2 and an explanation in Part 4 — employer declarations no payroll data can supply.",
    "No electronic 941-X is generated, the same gap the original Form 941 declares: file the adjusted return with the IRS directly."
  ]
}`;

test("Form 941-X is byte-identical to the IRS-coded golden", () => {
  assert.equal(JSON.stringify(build941X(Q_CORRECTION, 2026), null, 2), FORM_941X_GOLDEN);
});

test("a Form 941 quarter cannot be cancelled — the builder refuses by name", () => {
  assert.throws(
    () => build941X({ ...Q_CORRECTION, revision: "cancelled" }, 2026),
    /cannot be cancelled/,
  );
});

/* ------------------------------------------------------------------ */
/* 4. End to end, against the real subledger                           */
/* ------------------------------------------------------------------ */

interface T4Fixture {
  orgId: string;
  actorId: string;
  employeeId: string;
  documentId: string;
  earningComponentId: string;
  rowId: string;
}

async function seedT4Year(): Promise<T4Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
      payroll: {
        countries: ["CA"],
        t4Transmitter: {
          bn: "999999999RP0001",
          transmitterNumber: "MM555555",
          name: "Acme Ltd",
          contactName: "Pat Payroll",
          contactEmail: "pat@acme.test",
          contactPhone: "5555550100",
        },
      },
    })}::jsonb where id = ${org.orgId}`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Grace Hopper', true, ${org.subsidiaryId}, '{}'::jsonb)`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           sin_encrypted, sin_last3, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 'CA', 1, 1, '4', 'accrue',
            ${sealSecret("046454286")}, '286', true, ${actorId}, ${actorId})`);

  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${org.subsidiaryId}, '2026-07-21', 'CAD', 'draft', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, calculated_at, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18', '2026-07-21',
            2026, 'committed', now(), ${actorId}, ${actorId})`);

  const stubId = randomUUID();
  await db.execute(sql`
    insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                           pensionable_earnings, insurable_earnings, factors, created_by, updated_by)
    values (${stubId}, ${org.orgId}, ${documentId}, ${employeeId}, 'ON', 26, '2026-07-21',
            2026, 'CAD', '52000.0000', '42000.0000', '52000.0000', '52000.0000',
            ${JSON.stringify({ C: "3200.50", C2: "188.00", EI: "834.20" })}::jsonb,
            ${actorId}, ${actorId})`);

  const earningComponentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, country, taxable, created_by, updated_by)
    values (${earningComponentId}, ${org.orgId}, 'SAL', 'Salary', 'earning', 'CA', true,
            ${actorId}, ${actorId})`);
  const taxComponentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, system_key, country, taxable,
                                created_by, updated_by)
    values (${taxComponentId}, ${org.orgId}, 'FIT', 'Income tax', 'deduction', 'income_tax', 'CA',
            false, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                created_by, updated_by)
    values (${org.orgId}, ${stubId}, ${earningComponentId}, 'earning', 'Salary', '52000.0000',
            ${actorId}, ${actorId}),
           (${org.orgId}, ${stubId}, ${taxComponentId}, 'deduction', 'Income tax', '9100.7500',
            ${actorId}, ${actorId})`);

  return {
    orgId: org.orgId,
    actorId,
    employeeId,
    documentId,
    earningComponentId,
    rowId: `${employeeId}:ON:`,
  };
}

test(
  "issue → correct the ledger → amend: the delta names exactly the changed boxes, "
  + "and the original artifact survives byte for byte",
  { skip: !DB },
  async () => {
    const fx = await seedT4Year();
    try {
      const issued = await recordFilingIssue({
        orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
        taxYear: 2026, revision: "original", note: "Filed by Internet File Transfer",
      });
      assert.equal(issued.submission.revision, "original");
      assert.equal(issued.submission.revisionNumber, 1);
      assert.equal(issued.submission.supersedesId, null);
      assert.equal(issued.submission.slipCount, 1);
      assert.ok(issued.file, "the CA pack builds the T4 XML");
      assert.match(issued.file!.body, /<rpt_tcd>O<\/rpt_tcd>/);
      assert.match(issued.file!.body, /<EMPT_INC_AMT>52000\.00<\/EMPT_INC_AMT>/);
      const originalBytes = issued.file!.body;

      // A second original is refused — the agency would hold two returns.
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
          taxYear: 2026, revision: "original",
        }),
        /has already been issued/,
      );

      // Nothing has moved yet.
      let lifecycle = await filingLifecycle(fx.orgId, "CA", "t4", 2026);
      assert.equal(lifecycle.rows.length, 1);
      assert.equal(lifecycle.rows[0]!.status, "unchanged");
      assert.deepEqual(lifecycle.rows[0]!.changes, []);
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
          taxYear: 2026, revision: "amended", rowIds: [fx.rowId],
        }),
        /nothing changed on these slips/,
      );

      // THE CORRECTION IS MADE IN THE LEDGER: a taxable benefit that was
      // missed on the original run. The slip is never typed over.
      await db.execute(sql`
        insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                    created_by, updated_by)
        select org_id, id, ${fx.earningComponentId}, 'earning', 'Taxable benefit', '1500.0000',
               ${fx.actorId}, ${fx.actorId}
          from pay_stubs where org_id = ${fx.orgId} and pay_run_document_id = ${fx.documentId}`);

      lifecycle = await filingLifecycle(fx.orgId, "CA", "t4", 2026);
      assert.equal(lifecycle.rows[0]!.status, "changed");
      assert.deepEqual(
        lifecycle.rows[0]!.changes,
        [{
          code: "14",
          label: "Employment income",
          previous: "52000.0000",
          current: "53500.0000",
          redacted: false,
        }],
        "exactly one box moved, and it is named by the CRA's own box number",
      );

      const amended = await recordFilingIssue({
        orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
        taxYear: 2026, revision: "amended", rowIds: [fx.rowId],
      });
      assert.equal(amended.submission.revision, "amended");
      assert.equal(amended.submission.revisionNumber, 2);
      assert.equal(amended.submission.supersedesId, issued.submission.id);
      assert.match(amended.file!.body, /<rpt_tcd>A<\/rpt_tcd>/);
      assert.match(amended.file!.body, /<RPT_TCD>A<\/RPT_TCD>/);
      assert.match(amended.file!.body, /<EMPT_INC_AMT>53500\.00<\/EMPT_INC_AMT>/);
      assert.match(amended.file!.filename, /amended/);
      assert.deepEqual(
        amended.corrections[0]!.changes.map((change) => change.code),
        ["14"],
        "the file carries the same delta the operator approved",
      );

      // THE ORIGINAL IS EVIDENCE AND IS STILL THERE, UNCHANGED.
      const evidence = await filingArtifact(fx.orgId, issued.submission.id);
      assert.equal(evidence!.body, originalBytes);
      assert.match(evidence!.body, /<EMPT_INC_AMT>52000\.00<\/EMPT_INC_AMT>/);
      const history = await filingSubmissions(fx.orgId, "CA", "t4", 2026);
      assert.deepEqual(history.map((s) => [s.revisionNumber, s.revision]), [
        [1, "original"], [2, "amended"],
      ]);
      assert.deepEqual(
        history[0]!.slips[0]!.reported.fields.find((f) => f.code === "14"),
        { code: "14", label: "Employment income", value: "52000.0000" },
        "the first artifact still says what it said",
      );

      // And the row is now settled against the amended snapshot.
      lifecycle = await filingLifecycle(fx.orgId, "CA", "t4", 2026);
      assert.equal(lifecycle.rows[0]!.status, "unchanged");
      assert.equal(lifecycle.rows[0]!.lastRevision, "amended");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an original filing snapshots artifact bytes and slip evidence together",
  { skip: !DB },
  async () => {
    const fx = await seedT4Year();
    const country = "ZZ";
    const filingKey = `snapshot-${randomUUID()}`;
    const settingKey = `payrollSnapshot-${randomUUID()}`;
    let artifactObserved!: () => void;
    const artifactReady = new Promise<void>((resolve) => { artifactObserved = resolve; });
    let releaseArtifact!: () => void;
    const artifactRelease = new Promise<void>((resolve) => { releaseArtifact = resolve; });

    const readMarker = async (): Promise<string> => {
      const result = await db.execute<{ marker: string | null }>(sql`
        select settings->>${settingKey} as marker
          from orgs
         where id = ${fx.orgId}
      `);
      return result.rows[0]?.marker ?? "";
    };

    registerPayrollFilings({
      country,
      programTypes: [],
      yearEnd: [{
        key: filingKey,
        label: "Snapshot filing",
        cadence: "annual",
        population: async () => ({
          rowKey: "rowId",
          columns: [{ key: "marker", label: "Marker" }],
          rows: [{ rowId: "row-1", marker: await readMarker() }],
        }),
        slip: {
          build: async (_orgId, _taxYear, _rowId) => ({
            formCode: "ZZ_SNAPSHOT",
            formName: "Snapshot filing",
            headerFields: [],
            boxes: [{ code: "marker", label: "Marker", value: await readMarker() }],
          }),
        },
        download: {
          label: "Download snapshot",
          build: async () => {
            const marker = await readMarker();
            artifactObserved();
            await artifactRelease;
            return {
              filename: "snapshot.txt",
              contentType: "text/plain",
              body: marker,
            };
          },
        },
        amendment: {
          supported: true,
          revisions: ["amended"],
          vehicle: "same_form",
          downloadRefusal: "not used by this snapshot test",
        },
      }],
    });

    try {
      await db.execute(sql`
        update orgs
           set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ [settingKey]: "A" })}::jsonb
         where id = ${fx.orgId}
      `);

      const issuing = recordFilingIssue({
        orgId: fx.orgId,
        actorId: fx.actorId,
        country,
        filingKey,
        taxYear: 2026,
        revision: "original",
      });
      await artifactReady;

      // This commit lands while the issuing transaction is paused after the
      // artifact builder's read. A statement-level/read-committed sequence
      // would now persist artifact A beside slip evidence B.
      await db.execute(sql`
        update orgs
           set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ [settingKey]: "B" })}::jsonb
         where id = ${fx.orgId}
      `);
      releaseArtifact();

      const issued = await issuing;
      assert.equal(issued.file?.body, "A");
      assert.equal(issued.submission.slips[0]?.reported.fields[0]?.value, "A");
    } finally {
      releaseArtifact();
      unregisterPayrollFilings(country);
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a wrong SIN shows as a change without the number ever being displayed",
  { skip: !DB },
  async () => {
    const fx = await seedT4Year();
    try {
      await recordFilingIssue({
        orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
        taxYear: 2026, revision: "original",
      });
      await db.execute(sql`
        update employee_payroll_profiles
           set sin_encrypted = ${sealSecret("130692544")}, sin_last3 = '544'
         where org_id = ${fx.orgId} and employee_party_id = ${fx.employeeId}`);

      const lifecycle = await filingLifecycle(fx.orgId, "CA", "t4", 2026);
      assert.equal(lifecycle.rows[0]!.status, "changed");
      assert.deepEqual(lifecycle.rows[0]!.changes, [{
        code: null,
        label: "Social insurance number",
        previous: null,
        current: null,
        redacted: true,
      }]);
      // The snapshot holds a fingerprint, never the number.
      const history = await filingSubmissions(fx.orgId, "CA", "t4", 2026);
      const stored = JSON.stringify(history[0]!.slips[0]!.reported);
      assert.ok(!stored.includes("046454286"), "the issued SIN is not stored in the filing history");

      // The correction slip the operator reviews names the change and
      // withholds the value — neither SIN appears anywhere on the form.
      const slip = await filingCorrectionSlip(
        fx.orgId, "CA", "t4", 2026, fx.rowId, "amended",
      );
      assert.ok(
        slip.headerFields.some((f) => f.value === "changed (not displayed)"),
        "the amended slip says the SIN moved without printing it",
      );
      assert.ok(!JSON.stringify(slip).includes("046454286"));
      assert.ok(!JSON.stringify(slip).includes("130692544"));

      const amended = await recordFilingIssue({
        orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
        taxYear: 2026, revision: "amended", rowIds: [fx.rowId],
      });
      assert.match(amended.file!.body, /<SIN>130692544<\/SIN>/, "the corrected SIN is filed");
      // Once the amendment is issued the slip is settled: asking for another
      // correction refuses rather than restating the same figures.
      await assert.rejects(
        filingCorrectionSlip(fx.orgId, "CA", "t4", 2026, fx.rowId, "amended"),
        /nothing on Grace Hopper's T4 changed/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a slip the ledger no longer produces is ABSENT, must be cancelled, and the "
  + "cancellation files what was reported",
  { skip: !DB },
  async () => {
    const fx = await seedT4Year();
    try {
      const issued = await recordFilingIssue({
        orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
        taxYear: 2026, revision: "original",
      });

      // The employee should never have been on this entity: the run is pulled
      // back out of committed, so the subledger stops producing the slip.
      await db.execute(sql`
        update pay_runs set run_status = 'draft'
         where org_id = ${fx.orgId} and document_id = ${fx.documentId}`);

      let lifecycle = await filingLifecycle(fx.orgId, "CA", "t4", 2026);
      assert.equal(lifecycle.rows.length, 1);
      assert.equal(lifecycle.rows[0]!.status, "absent");
      // AMENDING is refused: there is nothing to restate.
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
          taxYear: 2026, revision: "amended", rowIds: [fx.rowId],
        }),
        /cancel them instead/,
      );

      // The UI confirmation is not an authorization boundary. Internal
      // callers must still provide the explanation that becomes audit
      // evidence before the service can create a cancellation artifact.
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
          taxYear: 2026, revision: "cancelled", rowIds: [fx.rowId],
        }),
        /nonblank cancellation reason/,
      );

      const cancelled = await recordFilingIssue({
        orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
        taxYear: 2026, revision: "cancelled", rowIds: [fx.rowId],
        reason: "Employee belonged to the other entity",
      });
      assert.equal(cancelled.submission.revision, "cancelled");
      assert.equal(cancelled.submission.supersedesId, issued.submission.id);
      assert.equal(cancelled.submission.note, "Employee belonged to the other entity");
      assert.match(cancelled.file!.body, /<rpt_tcd>C<\/rpt_tcd>/);
      assert.match(cancelled.file!.body, /<RPT_TCD>C<\/RPT_TCD>/);
      // The CRA's instruction: a cancelled slip carries the SAME information
      // as the original — which is only possible from the snapshot, because
      // the ledger no longer holds it.
      assert.match(cancelled.file!.body, /<EMPT_INC_AMT>52000\.00<\/EMPT_INC_AMT>/);
      assert.match(cancelled.file!.body, /<SIN>046454286<\/SIN>/);

      lifecycle = await filingLifecycle(fx.orgId, "CA", "t4", 2026);
      assert.equal(lifecycle.rows[0]!.status, "withdrawn");

      // Put the run back: the slip the employer withdrew is produced again,
      // and the disagreement is NAMED rather than quietly re-filed.
      await db.execute(sql`
        update pay_runs set run_status = 'committed'
         where org_id = ${fx.orgId} and document_id = ${fx.documentId}`);
      lifecycle = await filingLifecycle(fx.orgId, "CA", "t4", 2026);
      assert.equal(lifecycle.rows[0]!.status, "resurrected");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a pack that cannot correct a filing refuses by name, and files nothing",
  { skip: !DB },
  async () => {
    const fx = await seedT4Year();
    try {
      // The RL-1: no original can even be issued (no electronic file), and the
      // correction path refuses with Revenu Québec's own reason.
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "rl1",
          taxYear: 2026, revision: "amended", rowIds: ["anything"],
        }),
        (error: Error) => {
          assert.ok(error instanceof PayrollError);
          assert.match(error.message, /partner-gated RL-1 XML guide and guide IN-800/);
          assert.match(error.message, /SECOND original/);
          return true;
        },
      );
      await assert.rejects(
        filingCorrectionSlip(fx.orgId, "CA", "rl1", 2026, "anything", "amended"),
        /IN-800/,
      );

      // The ROE refuses for its own reason — the Service Canada serial number.
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "roe",
          taxYear: 2026, revision: "amended", rowIds: [fx.employeeId],
        }),
        /serial number Service Canada assigned/,
      );

      // Nothing was written by any of those refusals.
      assert.deepEqual(await filingSubmissions(fx.orgId, "CA", "rl1", 2026), []);
      assert.deepEqual(await filingSubmissions(fx.orgId, "CA", "roe", 2026), []);

      // A revision the pack does not declare is refused by name too.
      await recordFilingIssue({
        orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
        taxYear: 2026, revision: "original",
      });
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "US", filingKey: "941",
          taxYear: 2026, revision: "cancelled", rowIds: ["x"],
        }),
        /cannot be cancelled/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a correction cannot be issued before an original, or for a row never filed",
  { skip: !DB },
  async () => {
    const fx = await seedT4Year();
    try {
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
          taxYear: 2026, revision: "amended", rowIds: [fx.rowId],
        }),
        /has never been issued/,
      );
      await recordFilingIssue({
        orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
        taxYear: 2026, revision: "original",
      });
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
          taxYear: 2026, revision: "cancelled", rowIds: [`${randomUUID()}:ON:`],
        }),
        /were never issued/,
      );
      await assert.rejects(
        recordFilingIssue({
          orgId: fx.orgId, actorId: fx.actorId, country: "CA", filingKey: "t4",
          taxYear: 2026, revision: "amended", rowIds: [],
        }),
        /name the .* rows to amend/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
