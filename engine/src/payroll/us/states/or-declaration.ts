/**
 * Oregon withholding declarations — Form OR-W-4 and the state region.
 *
 * Authored beside the engine so the parent can wire these into
 * `us/jurisdictions.ts` without this module importing that file. Shape matches
 * IL_W4 / NC_NC4 / NC_REGION.
 *
 * Sources: Form OR-W-4; 2026 OR-W-4 instructions 150-101-402-1;
 * Publication 150-206-436 (Rev. 12-31-25).
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form OR-W-4 — Oregon Employee’s Withholding Allowance Certificate. */
export const OR_CERTIFICATE: PayrollCertificate = {
  key: "us_or_orw4",
  form: "OR-W-4",
  label: "Oregon Employee’s Withholding Allowance Certificate",
  scope: { level: "region", region: "OR" },
  purpose: "withholding",
  citation:
    "Oregon Form OR-W-4; 2026 Form OR-W-4 instructions 150-101-402-1; "
    + "Oregon Withholding Tax Formulas, 150-206-436 (Rev. 12-31-25)",
  summary:
    "Sets Oregon marital status, allowances, and extra withholding. If no OR-W-4 "
    + "(and no pre-2020 Oregon-only or federal W-4) is on file, HB 2119 requires "
    + "the employer to withhold eight percent of wages until the employee files.",
  storage: "certificate_rows",
  fields: [
    {
      key: "marital_status",
      label: "Line 1 — Marital status",
      kind: "choice",
      choices: [
        {
          value: "single",
          label: "Single",
          help:
            "OR-W-4: mark Single if you plan to file single, married filing separately, "
            + "or head of household. Uses the Single standard deduction, brackets, and "
            + "phase-out unless three or more allowances are claimed.",
        },
        {
          value: "married",
          label: "Married",
          help:
            "Married filing jointly or qualifying surviving spouse. Uses the Married "
            + "standard deduction, brackets, and the [M] phase-out. FAQ 7: only this "
            + "box uses the married phase-out amounts.",
        },
        {
          value: "married_higher_single",
          label: "Married, but withhold at the higher single rate",
          help:
            "FAQ 4 and Example 4: use the Single phase-out and the Single $100,000 "
            + "allowance cutoff, not the Married ones.",
        },
      ],
      default: "single",
      required: true,
      help:
        "Form OR-W-4 line 1. Head of household marks Single — the form has no third "
        + "filing-status box. Default Single is the form's own unread box, not a guess.",
    },
    {
      key: "allowances",
      label: "Line 2 — Oregon allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "From the OR-W-4 worksheets. Each allowance is a $263 annual credit in 2026, "
        + "subtracted AFTER the rate (FAQ 12). Single wages over $100,000, or Married "
        + "wages over $200,000, force this to zero — the publication's own cutoff.",
    },
    {
      key: "additional_per_period",
      label: "Line 3 — Additional Oregon withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount added AFTER the computer formula. It is not multiplied "
        + "by a rate and it is not an allowance.",
    },
    {
      key: "exempt",
      label: "Line 4 — Exempt from Oregon withholding",
      kind: "flag",
      help:
        "Line 4a exemption code plus the word Exempt on line 4b. For wages the "
        + "election expires February 15 of the following year; a new OR-W-4 is due "
        + "each year. Without a current exemption the employer withholds. This engine "
        + "honors the flag on file — dating the February 15 cutoff is certificate "
        + "administration, not a silent fallback.",
    },
    {
      key: "federal_income_tax_withheld",
      label: "Federal income tax withheld this period (formula input)",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Not an OR-W-4 line. Publication 150-206-436 builds BASE from wages minus "
        + "federal income tax withheld minus the standard deduction (FAQ 1: do not "
        + "include FICA; FAQ 11: the program must subtract it, up to the printed "
        + "annual cap). The payroll run supplies THIS PERIOD's federal income tax; "
        + "the engine annualizes it. A missing amount is refused — assuming zero "
        + "would over-withhold.",
    },
  ],
};

export const OR_REGION: PayrollRegionWithholding = {
  region: "OR",
  label: "Oregon income tax",
  implemented: true,
  // 150-206-436 assumes Oregon-source wages. OR-W-4 instructions address
  // part-year and nonresident filers. Nonresident wages earned in Oregon
  // are withheld under the same computer formula.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by 150-206-436: whether an Oregon resident's wages
  // earned entirely outside Oregon must be withheld on (and whether any
  // other-state credit reduces that withholding). Other DOR pages discuss
  // out-of-state employers; the formulas publication does not. Declared
  // unknown rather than guessed.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_or_orw4",
  subRegions: [
    {
      code: "TRIMET",
      label: "TriMet transit payroll tax",
      kind: "transit_district",
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "tenant", rateKey: "us_or_trimet" },
      implemented: true,
      citation:
        "Publication 150-206-436 (Rev. 12-31-25) does not publish a TriMet rate or "
        + "employee-withholding rule. The district exists; the rate is employer-entered. "
        + "orTransitWithholding refuses without that rate and never invents 0.8237%.",
    },
    {
      code: "LTD",
      label: "Lane Transit District payroll tax",
      kind: "transit_district",
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "tenant", rateKey: "us_or_ltd" },
      implemented: true,
      citation:
        "Publication 150-206-436 (Rev. 12-31-25) does not publish an LTD rate or "
        + "employee-withholding rule. The district exists; the rate is employer-entered. "
        + "orTransitWithholding refuses without that rate and never invents 0.80%.",
    },
    {
      code: "STT",
      label: "Oregon statewide transit tax",
      kind: "statewide_transit",
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "pack" },
      implemented: false,
      citation:
        "Publication 150-206-436 (Rev. 12-31-25) does not publish the statewide "
        + "transit tax or a withholding computation for it. Declared so the gap is "
        + "named; the 0.1% figure on Form OQ is not transcribed here.",
    },
  ],
  subRegionConflictRule: "both",
  citation:
    "Oregon Department of Revenue, Oregon Withholding Tax Formulas, 150-206-436 "
    + "(Rev. 12-31-25), effective January 1, 2026; Form OR-W-4; 2026 OR-W-4 "
    + "instructions 150-101-402-1",
};
