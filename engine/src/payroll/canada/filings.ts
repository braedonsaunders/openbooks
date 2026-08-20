import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { add } from "../../money.ts";
import { keyedFingerprint, unsealSecret } from "../../secrets.ts";
import { filingAccountRef, filingAccountsById } from "../../payroll-filing.ts";
import { buildRoeXml, type RoeIssueInput } from "../../payroll-roexml.ts";
import { buildT4Xml, t4SlipFromReported } from "../../payroll-t4xml.ts";
import { PayrollError } from "../../payroll-error.ts";
import { roeCandidates, roeRecord, t4Slips, t4Summary, ROE_REASON_CODES, type RoeReasonCode } from "../../payroll-yearend.ts";
import type {
  PayrollFilingCorrectionRow,
  PayrollFilingData,
  PayrollFilingSlipData,
  PayrollPackFilings,
  PayrollYearEndFiling,
} from "../../payroll-filing-registry.ts";
import { rl1Filing } from "./quebec/rl1-filing.ts";

/**
 * The CA pack's filing declaration: what Canada files, under which program
 * accounts, with which builders. The T4/ROE builders themselves live in
 * engine/src/payroll-t4xml.ts, payroll-roexml.ts and payroll-yearend.ts and
 * are unchanged — this module is the declaration that lets the generic
 * year-end surface reach them without naming Canada anywhere.
 *
 * Destined for `PAYROLL_COUNTRY_PACKS.CA.filings` (see the packs.ts handoff);
 * until then engine/src/payroll-filing-registry.ts serves it as a built-in.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Block 16 reason labels, per the Service Canada ROE instructions. */
const ROE_REASON_LABELS: Record<RoeReasonCode, string> = {
  A: "Shortage of work / end of contract or season",
  B: "Strike or lockout",
  D: "Illness or injury",
  E: "Quit",
  F: "Maternity",
  G: "Retirement",
  H: "Work sharing",
  J: "Apprenticeship training",
  K: "Other (comment required)",
  M: "Dismissal or suspension",
  N: "Leave of absence",
  P: "Parental",
  Z: "Compassionate care / family caregiver",
};

async function t4Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const [slips, summary] = await Promise.all([
    t4Slips(orgId, taxYear),
    t4Summary(orgId, taxYear),
  ]);
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "province", label: "Prov." },
      { key: "box14", label: "Box 14 income", align: "right", money: true },
      { key: "box16", label: "Box 16/16A CPP", align: "right", money: true },
      { key: "box18", label: "Box 18 EI", align: "right", money: true },
      { key: "box22", label: "Box 22 tax", align: "right", money: true },
      { key: "box24", label: "Box 24 EI insurable", align: "right", money: true },
      { key: "box26", label: "Box 26 pensionable", align: "right", money: true },
      { key: "box44", label: "Box 44 dues", align: "right", money: true },
    ],
    rows: slips.map((slip) => ({
      rowId: `${slip.employeePartyId}:${slip.province}:${slip.filingAccountId ?? ""}`,
      employee: slip.employeeName,
      province: slip.province,
      box14: slip.box14EmploymentIncome,
      // Boxes 16 + 16A together, exactly as the on-screen worksheet showed
      // them — money.ts arithmetic, never Number() addition.
      box16: add(slip.box16Cpp, slip.box16aCpp2),
      box18: slip.box18Ei,
      box22: slip.box22IncomeTax,
      box24: slip.box24EiInsurable,
      box26: slip.box26CppPensionable,
      box44: slip.box44UnionDues,
    })),
    totals: [
      { label: "Slips", value: String(summary.slips) },
      { label: "Employment income", value: summary.employmentIncome, money: true },
      {
        label: "CPP (employee + employer)",
        value: add(add(summary.employeeCpp, summary.employeeCpp2), summary.employerCpp),
        money: true,
      },
      { label: "EI (employee + employer)", value: add(summary.employeeEi, summary.employerEi), money: true },
      { label: "Income tax", value: summary.incomeTax, money: true },
      { label: "Remitted (posted bills)", value: summary.remitted, money: true },
    ],
  };
}

/**
 * One employee-province-account row as its T4 slip, box for box — the CRA's
 * own box numbers and printed titles. Quebec employment reports QPP in boxes
 * 17/17A and PPIP in 55/56, exactly as the engine's slip model carries it.
 */
async function t4Slip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const slips = await t4Slips(orgId, taxYear);
  const slip = slips.find(
    (s) => `${s.employeePartyId}:${s.province}:${s.filingAccountId ?? ""}` === rowId,
  );
  if (!slip) {
    throw new PayrollError(`no ${taxYear} T4 slip matches the requested employee/province row`);
  }
  const account = filingAccountRef(slip.filingAccountId, await filingAccountsById(orgId));
  const quebec = slip.isQuebec;
  return {
    formCode: "CA_T4",
    formName: "T4 — Statement of Remuneration Paid",
    formNumber: "T4",
    headerFields: [
      { label: "Employee's name", value: slip.employeeName },
      { label: "Province of employment (10)", value: slip.province },
      {
        label: "Employer's account number (54)",
        value: account.accountNumber
          ? `${account.accountNumber}${account.name ? ` · ${account.name}` : ""}`
          : "Unassigned",
      },
      { label: "Tax year", value: String(taxYear) },
    ],
    boxes: [
      { code: "14", label: "Employment income", value: slip.box14EmploymentIncome },
      quebec
        ? { code: "17", label: "Employee's QPP contributions", value: slip.box16Cpp }
        : { code: "16", label: "Employee's CPP contributions", value: slip.box16Cpp },
      quebec
        ? { code: "17A", label: "Employee's second QPP contributions", value: slip.box16aCpp2 }
        : { code: "16A", label: "Employee's second CPP contributions", value: slip.box16aCpp2 },
      { code: "18", label: "Employee's EI premiums", value: slip.box18Ei },
      { code: "22", label: "Income tax deducted", value: slip.box22IncomeTax },
      { code: "24", label: "EI insurable earnings", value: slip.box24EiInsurable },
      { code: "26", label: "CPP/QPP pensionable earnings", value: slip.box26CppPensionable },
      { code: "44", label: "Union dues", value: slip.box44UnionDues },
      ...(quebec
        ? [
            { code: "55", label: "Employee's PPIP premiums", value: slip.box55Qpip },
            { code: "56", label: "PPIP insurable earnings", value: slip.box56QpipInsurable },
          ]
        : []),
    ],
    notes: [
      "One T4 slip per province of employment, per payroll program account.",
      ...(quebec
        ? ["Québec employment: QPP reports in boxes 17/17A and PPIP in boxes 55/56; the employee also receives an RL-1."]
        : []),
    ],
  };
}

/**
 * One ROE candidate as the Record of Employment, block by block. Block 16
 * (reason for issue) is deliberately absent: it is the employer's declaration,
 * made when the ROE Web file is issued — never printed as a guess.
 */
async function roeSlip(orgId: string, _taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const record = await roeRecord(orgId, rowId);
  if (!record) {
    throw new PayrollError(
      "no Record of Employment can be assembled for this employee — ROEs exist for Canadian-pack employees only",
    );
  }
  return {
    formCode: "CA_ROE",
    formName: "Record of Employment",
    formNumber: "ROE",
    headerFields: [
      { label: "Employee's name", value: record.employeeName },
      { label: "Payroll reference number (Block 4)", value: record.payrollReference ?? "—" },
      {
        label: "CRA payroll account number (Block 5)",
        value: record.filingAccount.accountNumber ?? "Unassigned",
      },
      { label: "Occupation (Block 13)", value: record.occupation ?? "—" },
    ],
    boxes: [
      { code: "6", label: "Pay period type", value: record.payPeriodType },
      { code: "10", label: "First day worked", value: record.firstDayWorked ?? "—" },
      { code: "11", label: "Last day for which paid", value: record.lastDayPaid ?? "—" },
      { code: "12", label: "Final pay period ending date", value: record.finalPayPeriodEnd ?? "—" },
      { code: "15A", label: "Total insurable hours", value: record.totalInsurableHours, emphasis: true },
      { code: "15B", label: "Total insurable earnings", value: record.totalInsurableEarnings, emphasis: true },
      // Block 15C — insurable earnings by pay period, P1 = final period,
      // exactly the window Block 6's pay-period type declares.
      ...record.periods.map((period, index) => ({
        code: `15C P${index + 1}`,
        label: `Insurable earnings — pay period ending ${period.periodEnd}`,
        value: period.insurableEarnings,
      })),
      { code: "17A", label: "Vacation pay (final period)", value: record.vacationPayOnSeparation },
      { code: "17C", label: "Other monies (final period)", value: record.otherMoniesOnSeparation },
    ],
    notes: [
      "Block 16 (reason for issuing this ROE) and any comment are the employer's declaration, "
      + "made when the ROE Web file is issued — nothing in the payroll data can infer them.",
    ],
  };
}

async function roePopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const candidates = await roeCandidates(orgId, taxYear);
  return {
    rowKey: "employeePartyId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "lastDay", label: "Last day paid" },
    ],
    rows: candidates.map((candidate) => ({
      employeePartyId: candidate.employeePartyId,
      employee: candidate.employeeName,
      lastDay: candidate.terminatedOn ?? candidate.lastPayDate,
    })),
  };
}

/**
 * Parse the surface's `employees=<partyId>:<reasonCode>[:<comment>],…`
 * selection into ROE issue inputs. This parsing used to live in the roe-xml
 * API route; it is the filing's own contract, so it lives with the filing.
 */
export function parseRoeIssueParam(raw: string): RoeIssueInput[] {
  const issues: RoeIssueInput[] = [];
  for (const entry of raw.split(",").filter(Boolean)) {
    const [employeePartyId, reasonCode, ...comment] = entry.split(":");
    if (!UUID_RE.test(employeePartyId ?? "")
      || !(ROE_REASON_CODES as readonly string[]).includes(reasonCode ?? "")) {
      throw new PayrollError("invalid employee selection");
    }
    const text = decodeURIComponent(comment.join(":")).trim();
    if (text.length > 500) throw new PayrollError("comment too long");
    issues.push({
      employeePartyId: employeePartyId!,
      reasonCode: reasonCode as RoeReasonCode,
      comment: text || null,
    });
  }
  if (issues.length === 0 || issues.length > 500) {
    throw new PayrollError("invalid employee selection");
  }
  return issues;
}

/**
 * The T4's CORRECTION mechanics, as the CRA defines them.
 *
 * The CRA does not have a separate correction form. A T4 is corrected by
 * re-filing the SAME slip under a different report-type code — `A` for an
 * amended slip (values restated) and `C` for a cancelled one (the slip should
 * never have existed) — carried on the T619 transmittal, on each T4 slip and
 * on the T4 Summary, all three agreeing. Only the slips being corrected go in
 * the file; slips that did not change are not re-sent.
 *
 * Amended slips are RECOMPUTED from the subledger. Cancelled slips are filed
 * from the issued snapshot, because the CRA's instruction is that a cancelled
 * slip carries the same information as the original — and because the usual
 * reason to cancel is that the data behind the slip is gone.
 */
function t4Amendment(): NonNullable<PayrollYearEndFiling["amendment"]> {
  return {
    supported: true,
    revisions: ["amended", "cancelled"],
    vehicle: "same_form",
    download: {
      label: "Download corrected T4 XML",
      note:
        "The submission carries only the corrected slips, stamped with the CRA's report-type "
        + "code (A amended, C cancelled) on the T619, every slip and the summary. Validate "
        + "against the CRA schema for the filing year before transmitting.",
      build: async ({ orgId, taxYear, revision, rows }) => {
        if (revision === "amended") {
          const file = await buildT4Xml(orgId, taxYear, {
            reportTypeCode: "A",
            rowIds: rows.map((row) => row.rowId),
          });
          return {
            filename: file.filename,
            contentType: "application/xml; charset=utf-8",
            body: file.xml,
          };
        }
        const file = await buildT4Xml(orgId, taxYear, {
          reportTypeCode: "C",
          slips: rows.map((row) => t4SlipFromReported(row.previously, row.rowId)),
        });
        return {
          filename: file.filename,
          contentType: "application/xml; charset=utf-8",
          body: file.xml,
        };
      },
    },
    slip: { build: async (row) => t4CorrectionSlip(row) },
    confidential: (orgId, _taxYear, rowId) => t4ConfidentialFields(orgId, rowId),
  };
}

/**
 * The corrected T4, box by box — what was reported beside what is correct.
 *
 * The CRA's own paper is just a T4 with the "Amended" box ticked, so the
 * facsimile is the T4 with both values shown on the boxes that moved. That is
 * what the operator signs off and what the CRA's review asks about.
 */
async function t4CorrectionSlip(row: PayrollFilingCorrectionRow): Promise<PayrollFilingSlipData> {
  const cancelled = row.revision === "cancelled";
  const boxes = cancelled
    ? row.previously.fields
      .filter((field) => field.code != null)
      .map((field) => ({ code: field.code!, label: field.label, value: field.value }))
    : row.changes
      .filter((change) => change.code != null)
      .flatMap((change) => [
        { code: change.code!, label: `${change.label} — as filed`, value: change.previous ?? "—" },
        {
          code: change.code!,
          label: `${change.label} — amended`,
          value: change.current ?? "—",
          emphasis: true,
        },
      ]);
  const identity = row.changes
    .filter((change) => change.code == null)
    .map((change) => ({
      label: `As filed — ${change.label}`,
      value: change.redacted ? "changed (not displayed)" : (change.previous ?? "—"),
    }));
  if (boxes.length === 0 && identity.length === 0) {
    throw new PayrollError(
      `nothing on ${row.label}'s T4 changed — an amended slip that restates the same figures `
      + "tells the CRA nothing and must not be filed",
    );
  }
  return {
    formCode: "CA_T4",
    formName: cancelled
      ? "T4 — Statement of Remuneration Paid (CANCELLED)"
      : "T4 — Statement of Remuneration Paid (AMENDED)",
    formNumber: "T4",
    headerFields: [
      ...row.current.headerFields,
      { label: "Report type code", value: cancelled ? "C — cancelled" : "A — amended" },
      ...identity,
    ],
    boxes,
    notes: cancelled
      ? [
        "A cancelled T4 reports the SAME information as the original slip, stamped with report "
        + "type C — the CRA is being told this slip should never have existed, not that its "
        + "figures moved.",
        "Cancelling does not correct the payroll data. If the slip still has committed stubs "
        + "behind it, void or adjust the run as well, or the next return will file it again.",
      ]
      : [
        "Only the boxes that changed are restated; every other box on the original slip stands.",
        "The amounts are recomputed from committed pay stubs and opening balances — an amended "
        + "T4 can never disagree with the payroll subledger it summarizes.",
      ],
  };
}

/**
 * The identity facts a T4 amendment must compare but must never print.
 *
 * A wrong SIN is one of the commonest reasons an employer amends, and the
 * operator has to see that it moved. The SIN itself is sealed on the payroll
 * profile and stays there: what the filing snapshot holds is a keyed
 * fingerprint (HMAC under the org's data key), which proves a change and
 * discloses nothing.
 */
async function t4ConfidentialFields(
  orgId: string,
  rowId: string,
): Promise<{ label: string; fingerprint: string }[]> {
  const employeePartyId = rowId.split(":")[0] ?? "";
  if (!UUID_RE.test(employeePartyId)) return [];
  const rows = (await db.execute<{ sin_encrypted: string | null }>(sql`
    select sin_encrypted from employee_payroll_profiles
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
  `));
  const sin = unsealSecret(rows.rows[0]?.sin_encrypted ?? null);
  return [{
    label: "Social insurance number",
    fingerprint: sin ? keyedFingerprint("ca.sin", sin) : "",
  }];
}

/**
 * Built LAZILY (first lookup, not module evaluation): this module sits in an
 * import cycle — the registry reaches it, it reaches the builders, and the
 * builders reach the registry — so touching another module's consts during
 * evaluation is a TDZ crash whenever the other module happens to load first.
 * Everything inside the declaration is therefore only dereferenced at call
 * time.
 */
let cached: PayrollPackFilings | null = null;

export function caPackFilings(): PayrollPackFilings {
  cached ??= buildCaPackFilings();
  return cached;
}

function buildCaPackFilings(): PayrollPackFilings {
  return {
  country: "CA",
  programTypes: [
    { key: "ca_rp", label: "CRA payroll program account (RP)" },
  ],
  // Block 17A/17C attribution: which seeded component system_keys are
  // vacation pay vs other monies when paid on separation. Previously
  // hardcoded in the ROE query; now the pack's own declaration.
  separationPayments: {
    vacationPay: ["vacation_payout"],
    otherMonies: ["bonus"],
  },
  yearEnd: [
    {
      key: "t4",
      label: "T4 slips (Canada)",
      cadence: "annual",
      description:
        "Per-employee statement of remuneration paid. CPP shown includes CPP2 "
        + "(boxes 16 + 16A); Quebec employees report QPP/QPIP in the corresponding boxes.",
      emptyText: "No committed Canadian pay stubs for this year.",
      population: (orgId, taxYear) => t4Population(orgId, taxYear),
      slip: { build: (orgId, taxYear, rowId) => t4Slip(orgId, taxYear, rowId) },
      amendment: t4Amendment(),
      download: {
        label: "Download T4 XML",
        note: "Validate against the CRA schema for the filing year before transmitting.",
        build: async (orgId, taxYear) => {
          const file = await buildT4Xml(orgId, taxYear);
          return {
            filename: file.filename,
            contentType: "application/xml; charset=utf-8",
            body: file.xml,
          };
        },
      },
    },
    {
      key: "roe",
      label: "Records of Employment",
      // A SEPARATION document: due within days of an interruption of
      // earnings, per employee event — never a year-end return. The cadence
      // routes it to the Separations surface and the termination run's
      // Finish step instead of the year-end page.
      cadence: "separation",
      description:
        "Employees whose earnings were interrupted this year. Choose a reason "
        + "for issue to include an employee in the ROE Web file.",
      emptyText: "No employees with interrupted earnings this year.",
      population: (orgId, taxYear) => roePopulation(orgId, taxYear),
      slip: { build: (orgId, taxYear, rowId) => roeSlip(orgId, taxYear, rowId) },
      // An ROE IS amendable at Service Canada — but only by quoting the SERIAL
      // NUMBER Service Canada assigned to the original, which is issued on
      // submission to ROE Web and is not returned to the bulk-upload file this
      // pack produces. Nothing here holds it, so an "amended ROE" built from
      // this data could not identify the record it claims to replace, and
      // would be filed as a second original — a duplicate interruption of
      // earnings against a claimant's file. Refused by name instead.
      amendment: {
        supported: false,
        refusal:
          "An amended Record of Employment must quote the serial number Service Canada "
          + "assigned to the original, which is issued when the ROE is accepted by ROE Web and "
          + "is not carried back into the bulk upload file. OpenBooks does not hold that "
          + "serial number, so it cannot identify the record an amendment would replace — "
          + "amend the ROE directly in ROE Web, where the original can be found by serial "
          + "number. (Records of Employment are separation documents and live on the "
          + "Separations surface, never on year-end.)",
      },
      issue: {
        param: "employees",
        idColumn: "employeePartyId",
        reasonCodes: ROE_REASON_CODES.map((code) => ({
          code,
          label: ROE_REASON_LABELS[code],
          commentRequired: code === "K",
        })),
        commentMaxLength: 500,
        maxSelection: 500,
      },
      download: {
        label: "Download ROE XML",
        note: "Validate against the ROE Web schema before transmitting.",
        build: async (orgId, _taxYear, params) => {
          const issues = parseRoeIssueParam(params.employees ?? "");
          const file = await buildRoeXml(orgId, issues);
          return {
            filename: file.filename,
            contentType: "application/xml; charset=utf-8",
            body: file.xml,
          };
        },
      },
    },
    // The Quebec RL-1 (Revenu Québec) is authored under
    // engine/src/payroll/canada/quebec and carried here declaration-side —
    // the same memoized object `registerRl1Filing()` registers, so both
    // paths are one declaration (registerYearEndFiling is idempotent on the
    // identical object). Called only inside this lazy builder, never at
    // module evaluation, for the same import-cycle reason as everything
    // else here.
    rl1Filing(),
  ],
  };
}
