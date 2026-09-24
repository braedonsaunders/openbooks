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
 * Loonheffingen 2026, hoofdstuk 24 Heffingskortingen and hoofdstuk 15
 * Jaaropgaaf).
 */
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";
import { NL_AOK_2026 } from "./rates.ts";

/**
 * Model opgaaf gegevens voor de loonheffingen — the wage tax details form.
 *
 * `storage: "certificate_rows"`: a NEW certificate, so its answers live in a
 * certificate row, never in `employee_payroll_profiles` columns.
 *
 * Besides the korting election, the opgaaf carries the tabeltoepassing facts
 * the engine prices from: the AOW age class (read off the birth date in the
 * form's identity section) and the two elected kortingen that are not part
 * of the loonheffingskorting itself (AOK, JGK). Every per-employee input the
 * loonheffing engine reads is declared here or on `PREMIES_WERKNEMERSVERZEKERINGEN`
 * below — no `employee_payroll_profiles` column carries an NL fact, so no
 * profile migration, API branch or UI edit names this country.
 */
const OPGAAF_LOONHEFFINGEN: PayrollCertificate = {
  key: "nl_loonheffingen",
  form: "Model opgaaf gegevens voor de loonheffingen",
  label: "Wage tax details form (loonbelastingverklaring)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "Belastingdienst, Model opgaaf gegevens voor de loonheffingen; "
    + "Handboek Loonheffingen 2026, hoofdstuk 24 (Heffingskortingen)",
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
    {
      key: "age_class",
      label: "Leeftijdsklasse (tabeltoepassing)",
      kind: "choice",
      choices: [
        { value: "under_aow", label: "Jonger dan de AOW-leeftijd" },
        { value: "aow_1945", label: "AOW-leeftijd, geboren vóór 1946" },
        { value: "aow_1946", label: "AOW-leeftijd, geboren in 1946 of later" },
      ],
      // The witte tabellen price "jonger dan de AOW-leeftijd" unless the
      // loonstaat records otherwise (Gegevens voor tabeltoepassing).
      default: "under_aow",
      help: "Which loonheffing age column the employee falls in, read off the birth date on the "
        + "opgaaf. The schijventarief and the heffingskortingen differ per column "
        + "(Rekenvoorschriften 2026, Tabellen 1–5).",
    },
    {
      key: "aok_apply",
      label: "Alleenstaande-ouderenkorting toepassen",
      kind: "flag",
      default: "false",
      help: `Whether the alleenstaande-ouderenkorting (€ ${NL_AOK_2026} in 2026) is applied. Only for `
        + "employees at or above the AOW age who meet the Handboek conditions (Rekenvoorschriften "
        + "2026, Tabel 5: \"niet van toepassing\" below the AOW age — the engine refuses that "
        + "combination by name).",
    },
    {
      key: "jgk_apply",
      label: "Jonggehandicaptenkorting toepassen",
      kind: "flag",
      default: "false",
      help: "Whether the jonggehandicaptenkorting (€ 923 in 2026, € 462 above the AOW age) is set "
        + "against the period withholding (Rekenvoorschriften 2026, §5). Only with the employee's "
        + "election on file.",
    },
  ],
};

/**
 * The employer's own SV administration per employee: the contract-type fact
 * pricing the AWf premium, the employer-size fact pricing the Aof premium,
 * the Whk beschikking percentage from the Belastingdienst notice, and the
 * declared cumulative SV wage for the annual maximumpremieloon.
 *
 * No agency form carries these — they live in the loonstaat and on the
 * "mededeling of beschikking" the Belastingdienst issues per employer — so
 * `form` names the record, exactly as the DE pack's Kindernachweis names its
 * employer-collected proof rather than an agency form number. The Whk
 * percentage has no lawful default (it is the employer's own beschikking),
 * and neither the AWf nor the Aof leg has one either: all three are absent
 * until declared, and the engine refuses to price SV premiums without them
 * rather than assuming a contract, a size, or a percentage.
 */
const PREMIES_WERKNEMERSVERZEKERINGEN: PayrollCertificate = {
  key: "nl_premies",
  form: "Premies werknemersverzekeringen (werkgeversadministratie)",
  label: "SV premium facts (AWf, Aof, Whk)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "Belastingdienst, Handboek Loonheffingen 2026 (premies werknemersverzekeringen); "
    + "Tarieven, bedragen en percentages loonheffingen vanaf 1 januari 2026, Tabel 9 "
    + "(AWf/Aof percentages); Whk: \"Zie mededeling of beschikking\"",
  summary:
    "The employer's per-employee SV facts for the loonaangifte: which AWf premium the contract "
    + "attracts, which Aof premium the employer's size attracts, the Whk beschikking percentage, "
    + "and the declared SV wage year-to-date for the € 79.409 annual maximum.",
  storage: "certificate_rows",
  fields: [
    {
      key: "awf_laag",
      label: "AWf lage premie (vast contract)",
      kind: "flag",
      help: "Whether the employee's contract attracts the lage AWf premie (2,74% in 2026): a "
        + "qualifying vast (permanent) contract. Unset prices the hoge premie (7,74%). Required "
        + "whenever SV premiums price — the engine refuses to guess the contract type.",
    },
    {
      key: "aof_hoog",
      label: "Aof hoge premie (grote werkgever)",
      kind: "flag",
      help: "Whether the employer pays the hoge Aof premie (7,63% in 2026): a large employer "
        + "(premieplichtig loon above 25x the average). Unset prices the lage premie (6,27%). "
        + "Required whenever SV premiums price — the engine refuses to guess the employer size.",
    },
    {
      key: "whk_percent",
      label: "Whk-percentage (beschikking)",
      kind: "amount",
      decimals: 2,
      min: "0",
      max: "100",
      help: "The gedifferentieerde Whk premium percentage from the employer's own Belastingdienst "
        + "mededeling or beschikking (for example 1.25 means 1,25%). No default exists — the "
        + "percentage differs per employer — so the engine refuses to price without it.",
    },
    {
      key: "sv_loon_ytd",
      label: "Premieloon year-to-date",
      kind: "amount",
      decimals: 2,
      min: "0",
      default: "0",
      help: "Declared cumulative premieloon (SV wage) this year, for the € 79.409 annual "
        + "maximumpremieloon. Zero for an employee employed all year; copied from the prior "
        + "provider's report for a mid-year hire.",
    },
  ],
};

const NL_CERTIFICATES: PayrollPackCertificates = {
  country: "NL",
  certificates: [OPGAAF_LOONHEFFINGEN, PREMIES_WERKNEMERSVERZEKERINGEN],
};

export { NL_CERTIFICATES };
