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
