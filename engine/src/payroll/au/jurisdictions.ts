/**
 * The AU pack's declarations: the certificates its employees file, and the
 * states and territories that withhold.
 *
 * PAYG withholding is administered federally by the ATO — no state levies
 * income tax — so every region below carries the same federal answer. State
 * payroll taxes are a separate, employer-level levy (each state publishes its
 * own thresholds and rates); they are not transcribed here and travel through
 * no per-employee withholding channel.
 */
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";
import type {
  PayrollPackWithholding,
  PayrollRegionWithholding,
} from "../withholding-jurisdictions.ts";

/** Every state and territory code an AU employee profile may carry. */
export const AU_KNOWN_REGIONS: readonly string[] = [
  "NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT",
];

const AU_STATE_NAMES: Readonly<Record<string, string>> = {
  NSW: "New South Wales",
  VIC: "Victoria",
  QLD: "Queensland",
  SA: "South Australia",
  WA: "Western Australia",
  TAS: "Tasmania",
  NT: "Northern Territory",
  ACT: "Australian Capital Territory",
};

// ===========================================================================
// Certificates
// ===========================================================================

/**
 * Tax file number declaration (NAT 3092).
 *
 * Filed on hire and whenever the answers change. The answers determine the
 * PAYG withholding scale: whether the tax-free threshold is claimed from this
 * payer, whether the payee is a foreign resident, whether a STSL debt is
 * being repaid through withholding, and whether a TFN was quoted at all (no
 * TFN means withholding at the top marginal rate plus Medicare levy).
 * A later declaration overrides any previous one.
 */
const TFN_DECLARATION: PayrollCertificate = {
  key: "au_tfn_declaration",
  form: "TFN declaration",
  label: "Tax file number declaration",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "ATO Tax file number declaration (NAT 3092) — "
    + "https://www.ato.gov.au/forms-and-instructions/tfn-declaration",
  summary:
    "Filed when the employee starts and whenever the answers change. It tells "
    + "the payer which PAYG withholding scale applies: tax-free threshold "
    + "claim, residency, STSL debt, and whether a TFN was quoted.",
  storage: "certificate_rows",
  fields: [
    {
      key: "tax_file_number",
      label: "Tax file number",
      kind: "code",
      help: "The employee's TFN as quoted on the declaration. When no TFN is "
        + "quoted and no exemption is claimed, the payer must withhold at the "
        + "top marginal rate plus Medicare levy.",
    },
    {
      key: "residency",
      label: "Australian resident for tax purposes",
      kind: "choice",
      choices: [
        {
          value: "australian_resident",
          label: "Yes — Australian resident",
          help: "Withheld on the resident PAYG scales.",
        },
        {
          value: "foreign_resident",
          label: "No — foreign resident",
          help: "Withheld on the foreign-resident PAYG scale: no tax-free "
            + "threshold, different rates from the first dollar.",
        },
      ],
      default: "australian_resident",
      required: true,
      help: "The declaration's residency question. It selects the PAYG "
        + "withholding scale, not a rate entered by hand.",
    },
    {
      key: "working_holiday_maker",
      label: "Working holiday maker",
      kind: "flag",
      default: "false",
      help: "The declaration's working-holiday-maker question. Working holiday "
        + "makers are withheld under their own PAYG rates.",
    },
    {
      key: "tax_free_threshold",
      label: "Claim the tax-free threshold from this payer",
      kind: "flag",
      default: "false",
      help: "May be claimed from one payer at a time. Unclaimed unless the "
        + "declaration says so — that default is the statute, not an assumption.",
    },
    {
      key: "stsl_debt",
      label: "STSL debt (HELP, VSL, SSL, TSL or FS)",
      kind: "flag",
      default: "false",
      help: "Whether the payee has a study and training support loan to repay "
        + "through PAYG withholding on top of income tax.",
    },
  ],
};

export const AU_CERTIFICATES: PayrollPackCertificates = {
  country: "AU",
  certificates: [TFN_DECLARATION],
};

// ===========================================================================
// Withholding
// ===========================================================================

const PAYG_UNIMPLEMENTED =
  "PAYG withholding is administered federally by the ATO and the AU pack has "
  + "not transcribed the PAYG withholding schedules (Schedule 1), so income "
  + "tax is not computed for any state or territory yet";

function auRegion(code: string): PayrollRegionWithholding {
  return {
    region: code,
    label: `${AU_STATE_NAMES[code] ?? code} PAYG withholding`,
    implemented: false,
    unimplementedReason: PAYG_UNIMPLEMENTED,
    // States and territories levy no income tax on wages: there is nothing
    // to withhold for nonresidents and no resident out-of-region rule to
    // implement. PAYG is federal and follows the work payment.
    taxesNonresidentWages: false,
    residentWithholding: "none",
    residentWithholdingImplemented: true,
    certificateKey: "au_tfn_declaration",
    subRegions: [],
    subRegionConflictRule: "work_only",
    citation:
      "ATO PAYG withholding — "
      + "https://www.ato.gov.au/tax-rates-and-codes/tax-tables-overview",
  };
}

export const AU_WITHHOLDING: PayrollPackWithholding = {
  country: "AU",
  regions: AU_KNOWN_REGIONS.map(auRegion),
};
