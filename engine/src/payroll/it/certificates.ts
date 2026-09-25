/**
 * The IT pack's employee-filed withholding inputs.
 *
 * Italy has no W-4/TD1-style allowances form, and this declaration does not
 * invent one. There is exactly one input an employee files with the employer
 * to set their withholding: the declaration requesting the detrazioni
 * d'imposta for dependent family (art. 12 TUIR) and for employment income
 * (art. 13 TUIR), handed to the sostituto d'imposta, which applies the
 * detrazioni only on the strength of that declaration (art. 23 DPR 29
 * settembre 1973, n. 600). The fields below are that declaration's content —
 * who is dependent on the employee and the presumed total income the phaseout
 * is checked against — not cloned W-4 line names.
 *
 * What is NOT here: the 8/5/2-per-mille choices are expressed on the scheda
 * attached to the CU/730, not to the employer as a withholding input, so no
 * certificate declares them; INPS exemptions have no employee-filed form.
 */
import type { PayrollPackCertificates } from "../certificates.ts";

export const IT_CERTIFICATES: PayrollPackCertificates = {
  country: "IT",
  certificates: [
    {
      key: "it_detrazioni",
      // Not a numbered form: the declaration has no preprinted number, so the
      // form names the statute instead of inventing a code.
      form: "Detrazioni (artt. 12–13 TUIR)",
      label: "Dichiarazione del lavoratore per le detrazioni d'imposta",
      scope: { level: "country" },
      purpose: "withholding",
      citation:
        "artt. 12–13 TUIR (DPR 22 dicembre 1986, n. 917); "
        + "art. 23 DPR 29 settembre 1973, n. 600",
      summary:
        "Filed with the employer at hiring and whenever the family or income position changes. "
        + "Without it the sostituto withholds gross IRPEF with no detrazioni for family or employment.",
      storage: "certificate_rows",
      fields: [
        {
          key: "titolare_pensione",
          label: "Titolare di pensione o assegno equiparato",
          kind: "flag",
          default: "false",
          help: "The worker's income is art. 49 c. 2 lett. a) TUIR pension income: the IT engine "
            + "refuses it by name (pensionati use the TABELLA 7 detrazioni, not transcribed).",
        },
        {
          key: "tempo_determinato",
          label: "Rapporto di lavoro a tempo determinato",
          kind: "flag",
          help: "State whether this is a fixed-term contract. Fixed-term employment also owes the NASpI "
            + "add-on of 1.40% plus 0.50 percentage points per qualifying renewal (L. 92/2012 art. 2 c. 28); "
            + "the pack refuses fixed-term contracts because renewal and exemption facts are not yet priced. "
            + "Leave unanswered only when unknown: payroll will refuse rather than treat it as permanent.",
        },
        {
          key: "importo_aumenti_rinnovo",
          label: "Aumenti da rinnovo CCNL del periodo (sostitutiva 5%)",
          kind: "amount",
          decimals: 2,
          min: "0",
          help: "This period's contractual-renewal increases priced under the L. 199/2025 art. 1 c. 7 imposta "
            + "sostitutiva (5%, private-sector, 2025 lavoro income ≤ 33.000; AdE Circ. 2/E/2026). Recurring "
            + "minima: the amount repeats every period. Requires reddito_lavoro_2025; the engine carves the "
            + "amount out of ordinary IRPEF and prices the 5% line. Leave 0 when none was paid.",
        },
        {
          key: "importo_indennita_turni",
          label: "Indennità notturne/festive/di riposo/turni del periodo (sostitutiva 15%)",
          kind: "amount",
          decimals: 2,
          min: "0",
          help: "This period's night/holiday/rest-day/shift allowances priced under the L. 199/2025 art. 1 "
            + "c. 10–11 imposta sostitutiva (15%, cap 1.500/year, 2025 lavoro income ≤ 40.000). One-off per "
            + "period: declare what was actually paid. Requires reddito_lavoro_2025; the engine prices the "
            + "15% line within the annual cap. Leave 0 when none was paid.",
        },
        {
          key: "importo_premi_risultato",
          label: "Premi di risultato del periodo (sostitutiva 1%)",
          kind: "amount",
          decimals: 2,
          min: "0",
          help: "This period's performance bonuses priced under the L. 208/2015 art. 1 c. 182–189 imposta "
            + "sostitutiva at the 1% rate for 2026–2027 (cap 5.000/year). Requires premi_risultato_ammissibili; "
            + "the engine prices the 1% line within the annual cap. Leave 0 when none was paid.",
        },
        {
          key: "reddito_lavoro_2025",
          label: "Reddito di lavoro dipendente 2025 (soglie sostitutive)",
          kind: "amount",
          decimals: 2,
          min: "0",
          help: "The worker's 2025 lavoro income: the ceiling for the 2026 substitute regimes (≤ 33.000 for "
            + "renewal increases, ≤ 40.000 for shift allowances). Required whenever a substitute amount is "
            + "declared; the run refuses while it is absent.",
        },
        {
          key: "premi_risultato_ammissibili",
          label: "Premi di risultato ammissibili (criteri L. 208/2015)",
          kind: "flag",
          help: "State whether the declared performance bonuses meet the L. 208/2015 incrementality and "
            + "registered-contract criteria for the substitute regime. Required whenever premi are declared; "
            + "the run refuses while eligibility is unknown.",
        },
        {
          key: "anzianita_post_1995",
          label: "Iscritto dopo il 31 dicembre 1995 (o opzione contributivo)",
          kind: "flag",
          help: "Workers first insured after 31 December 1995 (or on the contributivo option) fall "
            + "under the L. 335/1995 massimale for the tax year. Not part of the detrazioni "
            + "form; recorded here as the pack's only employee-filed input channel. Leave unanswered "
            + "when unknown: above the annual massimale, payroll refuses rather than assuming pre-1996 status.",
        },
        {
          key: "domicilio_comune",
          label: "Comune di domicilio fiscale (codice catastale)",
          kind: "code",
          subRegion: { side: "residence" },
          help: "The fiscal domicile comune that selects the addizionale comunale (codice catastale, "
            + "e.g. H501 for Roma). Domicile, never the workplace, attributes both surtaxes.",
        },
        {
          key: "coniuge_a_carico",
          label: "Coniuge fiscalmente a carico",
          kind: "flag",
          help: "The spouse's total income is within the art. 12 TUIR threshold, so the detrazione "
            + "per coniuge a carico applies.",
        },
        {
          key: "figli_a_carico",
          label: "Figli fiscalmente a carico (numero)",
          kind: "count",
          min: "0",
          default: "0",
          help: "Count of dependent children declared under art. 12 TUIR, including the age and "
            + "disability conditions the detrazione per figli a carico depends on.",
        },
        {
          key: "altri_familiari_a_carico",
          label: "Altri familiari a carico (numero)",
          kind: "count",
          min: "0",
          default: "0",
          help: "Other dependent family members living with the employee under art. 12 TUIR.",
        },
        {
          key: "reddito_complessivo_presunto",
          label: "Reddito complessivo presunto (EUR)",
          kind: "amount",
          decimals: 2,
          min: "0",
          help: "The employee's presumed total income for the year, which the detrazioni phaseout "
            + "is checked against.",
        },
      ],
    },
  ],
};
