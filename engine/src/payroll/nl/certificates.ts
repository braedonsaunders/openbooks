/**
 * The NL pack's certificate declaration: the form an employee files to set
 * their own loonheffing withholding.
 *
 * Authored HERE, in the pack, beside the engine that will read it — the same
 * arrangement `engine/src/payroll/canada/jurisdictions.ts` and
 * `engine/src/payroll/us/jurisdictions.ts` use. Nothing in the generic layer
 * (`certificates.ts`) names this form, so the Netherlands answers the same
 * interface Canada and the United States do.
 *
 * The form is the Belastingdienst's "Model opgaaf gegevens voor de
 * loonheffingen" (the loonbelastingverklaring). Its withholding content is a
 * single question — whether the employer must apply the loonheffingskorting
 * (the labour tax credit, arbeidskorting, plus the general tax credit,
 * algemene heffingskorting). Everything else on the form is identity data for
 * the loonstaat (name, date of birth, citizen service number), not
 * withholding, so it is not declared here. Applying the korting needs the
 * employee's dated and signed request, it is allowed at exactly one employer
 * or benefits agency at a time, and the choice is recorded on the loonstaat
 * ("Gegevens voor tabeltoepassing") and on the jaaropgaaf (Handboek
 * Loonheffingen, hoofdstuk 20 Heffingskortingen and hoofdstuk 12).
 */
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";

/**
 * Model opgaaf gegevens voor de loonheffingen — the wage tax details form.
 *
 * `storage: "certificate_rows"`: a NEW certificate, so its answers live in a
 * certificate row, never in `employee_payroll_profiles` columns.
 */
const OPGAAF_LOONHEFFINGEN: PayrollCertificate = {
  key: "nl_loonheffingen",
  form: "Model opgaaf gegevens voor de loonheffingen",
  label: "Wage tax details form (loonbelastingverklaring)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "Belastingdienst, Model opgaaf gegevens voor de loonheffingen; "
    + "Handboek Loonheffingen 2026, hoofdstuk 20 (Heffingskortingen)",
  summary:
    "Filed on hire and whenever the employee's circumstances change. It identifies the employee "
    + "for the loonstaat and records whether the employer must apply the loonheffingskorting "
    + "when looking up the witte loonbelastingtabellen.",
  storage: "certificate_rows",
  fields: [
    {
      key: "apply_loonheffingskorting",
      label: "Loonheffingskorting toepassen",
      kind: "flag",
      // No form on file is withheld WITHOUT the korting: applying it needs
      // the employee's dated and signed request (Handboek, hoofdstuk 20).
      default: "false",
      help: "Whether the employer applies the loonheffingskorting — the arbeidskorting (labour tax "
        + "credit) together with the algemene heffingskorting (general tax credit) — when looking up "
        + "the employee's withholding in the witte loonbelastingtabellen. Only with the employee's "
        + "dated and signed opgaaf on file, and at no more than one employer or benefits agency at "
        + "a time. Without the form on file the tables are applied without the korting.",
    },
  ],
};

const NL_CERTIFICATES: PayrollPackCertificates = {
  country: "NL",
  certificates: [OPGAAF_LOONHEFFINGEN],
};

export { NL_CERTIFICATES };
