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

/**
 * Medicare levy variation declaration (QC17088 in the instrument's Guide to
 * other relevant documents and links).
 *
 * Lodged with the TFN declaration. The answer the pack carries is the
 * Medicare levy EXEMPTION claim, which selects the withholding scale: a
 * full exemption takes scale 5 and a half exemption scale 6 — even where
 * the TFN declaration also claims the tax-free threshold (the instrument's
 * General example 2 claims the threshold and still applies scale 5 for a
 * full exemption). A variation declaration that seeks only the family /
 * spouse low-income levy adjustment (questions 9–12) leaves the scale
 * where the TFN answers put it; that adjustment itself is refused machinery
 * (see AU_REFUSED_2027), so the engine applies no WLA.
 */
const MEDICARE_VARIATION_DECLARATION: PayrollCertificate = {
  key: "au_medicare_levy_variation",
  form: "Medicare levy variation declaration",
  label: "Medicare levy variation declaration",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "Medicare levy variation declaration — the instrument's Guide to other "
    + "relevant documents and links lists it under quick code QC17088 "
    + "(F2026L00716)",
  summary:
    "Lodged with the TFN declaration when the employee claims a Medicare "
    + "levy exemption. A full exemption takes PAYG scale 5, a half exemption "
    + "scale 6; no claim leaves scales 1–3 selected by the TFN answers.",
  storage: "certificate_rows",
  fields: [
    {
      key: "medicare_exemption",
      label: "Medicare levy exemption claimed",
      kind: "choice",
      choices: [
        {
          value: "none",
          label: "No exemption",
          help: "Withheld on the TFN scale (1, 2 or 3).",
        },
        {
          value: "full",
          label: "Full exemption",
          help: "Withheld on PAYG scale 5.",
        },
        {
          value: "half",
          label: "Half exemption",
          help: "Withheld on PAYG scale 6.",
        },
      ],
      default: "none",
      required: true,
      help: "The variation declaration's exemption claim. It selects the "
        + "PAYG withholding scale, not a rate entered by hand. Family and "
        + "spouse low-income adjustments on the same form are not applied.",
    },
  ],
};

export const AU_CERTIFICATES: PayrollPackCertificates = {
  country: "AU",
  certificates: [TFN_DECLARATION, MEDICARE_VARIATION_DECLARATION],
};

// ===========================================================================
// Withholding
// ===========================================================================

function auRegion(code: string): PayrollRegionWithholding {
  return {
    region: code,
    label: `${AU_STATE_NAMES[code] ?? code} PAYG withholding`,
    // PAYG withholding is federal and uniform: the engine computes the same
    // Schedule 1 withholding for every state and territory.
    implemented: true,
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
      "Taxation Administration (Withholding Schedules) Instrument 2026 "
      + "(F2026L00716), Schedule 1 — "
      + "https://www.legislation.gov.au/F2026L00716/asmade/2026-06-12/"
      + "text/original/epub/OEBPS/document_1/document_1.html",
  };
}

export const AU_WITHHOLDING: PayrollPackWithholding = {
  country: "AU",
  regions: AU_KNOWN_REGIONS.map(auRegion),
};
