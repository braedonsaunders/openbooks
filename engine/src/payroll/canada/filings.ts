import { add } from "../../money.ts";
import { buildRoeXml, type RoeIssueInput } from "../../payroll-roexml.ts";
import { buildT4Xml } from "../../payroll-t4xml.ts";
import { PayrollError } from "../../payroll-run.ts";
import { roeCandidates, t4Slips, t4Summary, ROE_REASON_CODES, type RoeReasonCode } from "../../payroll-yearend.ts";
import type { PayrollFilingData, PayrollPackFilings } from "../../payroll-filing-registry.ts";
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
      description:
        "Per-employee statement of remuneration paid. CPP shown includes CPP2 "
        + "(boxes 16 + 16A); Quebec employees report QPP/QPIP in the corresponding boxes.",
      emptyText: "No committed Canadian pay stubs for this year.",
      population: (orgId, taxYear) => t4Population(orgId, taxYear),
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
      description:
        "Employees whose earnings were interrupted this year. Choose a reason "
        + "for issue to include an employee in the ROE Web file.",
      emptyText: "No employees with interrupted earnings this year.",
      population: (orgId, taxYear) => roePopulation(orgId, taxYear),
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
