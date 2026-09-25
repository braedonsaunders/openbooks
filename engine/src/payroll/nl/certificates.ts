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
      // The table and volksverzekeringen liability differ by age class; the
      // pack has no birth-date input from which this can be derived safely.
      required: true,
      help: "Which loonheffing age column the employee falls in, read off the birth date on the "
        + "opgaaf. This must be recorded; an absent answer cannot default to under-AOW. "
        + "The schijventarief and the heffingskortingen differ per column "
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
        + "election on file AND a declared jgk_basis below — the engine refuses the reduction "
        + "without an established Wajong entitlement (Handboek Loonheffingen 2026, §24.1.5).",
    },
    {
      key: "jgk_basis",
      label: "Jonggehandicaptenkorting grondslag",
      kind: "choice",
      choices: [
        {
          value: "wajong_benefit",
          label: "Wajong-uitkering wordt ontvangen",
          help: "The employee receives a Wajong benefit, directly or through employer payment.",
        },
        {
          value: "uwv_entitlement",
          label: "Wajong-gerechtigd zonder uitkering (UWV-brief aanwezig)",
          help: "The employee is eligible for a Wajong benefit but does not receive one — the "
            + "employer retains the UWV entitlement letter and records its reference in "
            + "jgk_evidence.",
        },
      ],
      help: "The Wajong entitlement grounding the jonggehandicaptenkorting (Handboek "
        + "Loonheffingen 2026, §24.1.5: only people receiving a Wajong benefit, or eligible "
        + "for one but not receiving it). Absent until declared — without it the korting "
        + "is refused.",
    },
    {
      key: "jgk_evidence",
      label: "Jonggehandicaptenkorting bewijsstuk",
      kind: "code",
      help: "Reference to the retained UWV entitlement letter (beschikking), required when "
        + "jgk_basis is Wajong-eligible-without-benefit. The employer must keep the letter; "
        + "this reference is the audit link to it.",
    },
  ],
};

/**
 * The employer's own SV administration per employee: the contract-type fact
 * pricing the AWf premium (or the Ufo classification for covered government
 * employees, who owe Ufo instead of AWf), the employer-size fact pricing
 * the Aof premium, the Whk beschikking percentage from the Belastingdienst
 * notice, and the declared cumulative SV wage for the annual maximumpremieloon.
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
  label: "SV premium facts (AWf/Ufo, Aof, Whk)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "Belastingdienst, Handboek Loonheffingen 2026 (premies werknemersverzekeringen); "
    + "Tarieven, bedragen en percentages loonheffingen vanaf 1 januari 2026, Tabel 9 "
    + "(AWf/Aof percentages); Whk: \"Zie mededeling of beschikking\"",
  summary:
    "The employer's per-employee SV facts for the loonaangifte: which AWf premium the contract "
    + "attracts (or the Ufo classification for covered government employees, who owe no AWf), "
    + "which Aof premium the employer's size attracts, the Whk beschikking percentage, "
    + "and the declared SV wage year-to-date for the € 79.409 annual maximum.",
  storage: "certificate_rows",
  fields: [
    {
      key: "awf_laag",
      label: "AWf lage premie (vast contract)",
      kind: "flag",
      help: "Whether the employee's contract attracts the lage AWf premie (2,74% in 2026): a "
        + "qualifying vast (permanent) contract. Unset prices the hoge premie (7,74%). Required "
        + "whenever SV premiums price — the engine refuses to guess the contract type. Leave unset "
        + "for Ufo-covered government employees (see ufo): AWf plus Ufo refuses as contradictory.",
    },
    {
      key: "ufo",
      label: "Ufo-covered government employee (overheid)",
      kind: "flag",
      default: "false",
      help: "Whether the employee is a covered government employee (Wet privatisering ABP scope): "
        + "government employers owe no AWf for them and instead owe the Ufo premie (0,68% in 2026, "
        + "Handboek Loonheffingen §7.4), priced on the WW leg. Leave awf_laag unset for them. "
        + "Defaults to false (private-sector AWf treatment).",
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
      label: "Premieloon year-to-date (opening balance)",
      kind: "amount",
      decimals: 2,
      min: "0",
      help: "Verified premieloon (SV wage) already paid this year BEFORE this employer — the "
        + "opening balance for the € 79.409 annual maximumpremieloon. Enter an explicit 0 for "
        + "an employee employed all year by this employer; copied from the prior provider's "
        + "report for a mid-year hire. No default exists: the engine adds this employer's own "
        + "committed current-year SV base on top, and refuses without a recorded opening "
        + "rather than assuming zero.",
    },
  ],
};

/**
 * Belasting- en premieplicht (the employer's own per-employee record, not a
 * Belastingdienst form).
 *
 * The engine transcribes only the standard resident situation (the witte
 * tabellen for a fully liable employee). The Rekenvoorschriften distinguish
 * standard from herleidingssituaties with woonland-specific tables
 * (chapters 7–8); a foreign-resident or partially liable employee must not
 * be priced from the resident table. There is no lawful default — the
 * classification is absent until the employer records it — so the engine
 * refuses to calculate without it, and refuses the non-standard classes by
 * name until their tables are transcribed.
 */
const BELASTING_PREMIEPLICHT: PayrollCertificate = {
  key: "nl_tax_liability",
  form: "Belasting- en premieplicht (werkgeversadministratie)",
  label: "Tax and premium liability class",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "Belastingdienst, Rekenvoorschriften 2026 v2 (standard versus "
    + "herleidingssituaties, woonland-specific tables, chapters 7–8)",
  summary:
    "The employer's per-employee liability classification for table selection: "
    + "only the standard resident situation prices from the witte tabellen.",
  storage: "certificate_rows",
  fields: [
    {
      key: "liability_class",
      label: "Belasting- en premieplicht",
      kind: "choice",
      choices: [
        {
          value: "standard_resident",
          label: "Standard resident (volledig belasting- en premieplichtig)",
          help: "Living in the Netherlands and fully liable: priced from the witte tabellen.",
        },
        {
          value: "foreign_resident",
          label: "Foreign resident (woonland buiten Nederland)",
          help: "Not priced: the woonland-specific tables are not transcribed.",
        },
        {
          value: "partial_dutch_liability",
          label: "Partial Dutch liability (beperkt belasting- of premieplichtig)",
          help: "Not priced: the herleidingssituatie tables are not transcribed.",
        },
      ],
      required: true,
      help: "Which liability situation selects the table. Only the standard resident "
        + "situation is implemented; any other situation refuses by name.",
    },
  ],
};

const NL_CERTIFICATES: PayrollPackCertificates = {
  country: "NL",
  certificates: [OPGAAF_LOONHEFFINGEN, PREMIES_WERKNEMERSVERZEKERINGEN, BELASTING_PREMIEPLICHT],
};

export { NL_CERTIFICATES };
