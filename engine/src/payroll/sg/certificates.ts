/**
 * The SG pack's certificate declaration: the two facts the CPF Contribution
 * Rate Table prices on.
 *
 * Singapore files NO employee withholding certificate — there is no monthly
 * income-tax withholding to vary. IRAS: "Employers are responsible for
 * reporting the employment income of all individuals who have worked for
 * them", and "The information submitted by employers will be pre-filled in
 * employees' electronic Income Tax Returns" (Reporting Employee Earnings
 * (IR8A, App 8A/8B)). The employer's duty is to REPORT; the employee is
 * assessed annually. The only employer-side withholding IRAS names is tax
 * clearance: "you are required to seek tax clearance for him. As an
 * employer, you have the responsibility to file the Form IR21 and withhold
 * all monies due to the employee for tax clearance purpose" (Tax Clearance
 * for Foreign & SPR Employees (IR21)) — a departing-non-citizen event, not
 * a monthly line, and refused by name in the pack.
 *
 * What the monthly engine DOES need per employee are the two answers Table
 * 1 is keyed on — CPF status ("for Singapore Citizens or Singapore
 * Permanent Residents (3rd year onwards)") and the age band ("Employee's
 * Age (Years) for the calendar month"). No agency form collects them (the
 * employer takes them at onboarding; the Board requires the employer to
 * know — "Please ensure your employees inform you when they become
 * Singapore Citizens or Singapore Permanent Residents, as different CPF
 * contribution rates are applicable"). So this declaration records them as
 * certificate answers with `storage: "certificate_rows"`, and its form
 * field says so plainly instead of borrowing a form number that does not
 * exist. An employee with no such declaration on file is refused, never
 * guessed.
 */
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";

const SG_CPF_STATUS: PayrollCertificate = {
  key: "sg_cpf_status",
  form: "No agency form — CPF status and age band recorded at onboarding",
  label: "CPF status declaration (citizenship/PR status and age band)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "CPF Board, CPF Contribution Rate Table from 1 January 2026, Table 1 (status and age-band rows); "
    + "CPF Board, Who should receive CPF contributions (employer must know SC/SPR status; "
    + "foreigners exempt); IRAS, Reporting Employee Earnings (IR8A, App 8A/8B) (employer reports, "
    + "does not withhold); IRAS, Tax Clearance for Foreign & SPR Employees (IR21)",
  summary:
    "Recorded at onboarding and whenever the employee's status changes. It carries the two facts "
    + "the CPF rate table prices on — CPF status and age band — because no IRAS or CPF Board form "
    + "varies a monthly withholding that does not exist.",
  storage: "certificate_rows",
  fields: [
    {
      key: "cpf_status",
      label: "CPF status",
      kind: "choice",
      choices: [
        {
          value: "citizen",
          label: "Singapore Citizen",
          help: "Table 1 (full employer/employee rates) applies. The 2026 engine computes this status.",
        },
        {
          value: "spr_3rd_year",
          label: "Singapore Permanent Resident, 3rd year onwards",
          help: "Table 1 applies (\"for Singapore Citizens or Singapore Permanent Residents (3rd year "
            + "onwards)\"). The 2026 engine computes this status at full rates.",
        },
        {
          value: "spr_1st_year",
          label: "Singapore Permanent Resident, 1st year",
          help: "Graduated rates (Tables 2/4) apply unless the Board approves a joint application for "
            + "higher rates. Refused by name — not transcribed.",
        },
        {
          value: "spr_2nd_year",
          label: "Singapore Permanent Resident, 2nd year",
          help: "Graduated rates (Tables 3/5) apply unless the Board approves a joint application for "
            + "higher rates. Refused by name — not transcribed.",
        },
        {
          value: "foreigner",
          label: "Neither citizen nor PR",
          help: "No CPF is payable (\"Persons who are not Singapore Citizens or Singapore Permanent "
            + "Residents\" are exempt); a MOM foreign-worker levy applies instead. Refused by name — "
            + "not transcribed.",
        },
      ],
      required: true,
      help: "The employee's CPF status, which selects the contribution-rate table. Citizens and 3rd-year "
        + "SPRs price under Table 1; 1st/2nd-year SPRs price under the graduated Tables 2–5; foreigners "
        + "pay no CPF. Nothing is assumed when this is unanswered.",
    },
    {
      key: "age_band",
      label: "Age band",
      kind: "choice",
      choices: [
        {
          value: "le55",
          label: "55 & below",
          help: "Table 1 row: 37% total / 20% employee on OW above $750 (max $2,960 / $1,600). "
            + "The 2026 engine computes this band.",
        },
        {
          value: "b55_60",
          label: "Above 55 – 60",
          help: "Table 1 row: 34% total / 18% employee (max $2,720 / $1,440). Refused by name — "
            + "not transcribed.",
        },
        {
          value: "b60_65",
          label: "Above 60 – 65",
          help: "Table 1 row: 25% total / 12.5% employee (max $2,000 / $1,000). Refused by name — "
            + "not transcribed.",
        },
        {
          value: "b65_70",
          label: "Above 65 – 70",
          help: "Table 1 row: 16.5% total / 7.5% employee (max $1,320 / $600). Refused by name — "
            + "not transcribed.",
        },
        {
          value: "gt70",
          label: "Above 70",
          help: "Table 1 row: 12.5% total / 5% employee (max $1,000 / $400). Refused by name — "
            + "not transcribed.",
        },
      ],
      required: true,
      help: "The employee's Table 1 age band for the calendar month. Only \"55 & below\" computes in "
        + "2026; every other band is refused by name.",
    },
  ],
};

const SG_CERTIFICATES: PayrollPackCertificates = {
  country: "SG",
  certificates: [SG_CPF_STATUS],
};

export { SG_CERTIFICATES };
