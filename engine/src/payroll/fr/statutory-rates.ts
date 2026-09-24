import type { PayrollPackRates, StatutoryRateResolution } from "../statutory-rates.ts";

/** Only an explicit account-level true declaration qualifies for 3.45%. */
export function frAllocFamReducedEligible(
  resolution: StatutoryRateResolution,
  region: string,
  filingAccountId: string | null,
): boolean {
  return resolution.values("fr_allocfam", { region, filingAccountId })?.reduced_rate_eligible === "true";
}

/** France's employer rates and account-level classification facts. */
export const FR_PACK_RATES: PayrollPackRates = {
  country: "FR",
  slots: [
    {
      key: "fr_atmp",
      label: "Taux AT/MP",
      scope: "filing_account",
      programType: "fr_siret",
      systemKeys: ["atmp"],
      regions: ["FR"],
      whenUnconfigured: "legacy",
      citation: "Code de la sécurité sociale, art. L242-5 (taux notifié par la caisse)",
      variesBecause:
        "The caisse notifies each establishment its own AT/MP rate from its activity risk class and sinistrality — a figure no published table can supply.",
      fields: [
        {
          key: "taux", label: "Taux AT/MP (%)", kind: "percent", decimals: 4,
          min: "0", max: "100", required: true,
          help: "As a percent, as the caisse notifies it: 1.1 is 1.1%. Enter the rate notified for this establishment.",
        },
      ],
    },
    {
      key: "fr_versement_mobilite",
      label: "Taux versement mobilité",
      scope: "filing_account",
      programType: "fr_siret",
      systemKeys: ["cdn_er"],
      regions: ["FR"],
      whenUnconfigured: "legacy",
      citation: "URSSAF, taux et barèmes — versement mobilité (employers with 11+ employees)",
      variesBecause:
        "The rate is set per autorité organisatrice de la mobilité from the establishment's commune — a figure no published table can supply.",
      fields: [
        {
          key: "taux", label: "Taux versement mobilité (%)", kind: "percent", decimals: 4,
          min: "0", max: "100", required: true,
          help: "As a percent, as the URSSAF versement-mobilité lookup returns it for this establishment's commune.",
        },
      ],
    },
    {
      key: "fr_allocfam",
      label: "Eligibility for reduced family-benefit contribution rate",
      scope: "filing_account",
      programType: "fr_siret",
      systemKeys: ["allocfam_er"],
      regions: ["FR"],
      // Ordinary employers owe 5.25% by default. A tenant must explicitly
      // record its qualifying exemption/special regime before the reduced
      // 3.45% rate can be considered.
      whenUnconfigured: "zero",
      citation:
        "URSSAF, cotisation d'allocations familiales (updated 10 June 2026); CSS art. L.241-6-1",
      variesBecause:
        "Only specified exemption and special-regime employers may use the reduced rate; eligibility belongs to the employer's filing account.",
      fields: [
        {
          key: "reduced_rate_eligible",
          label: "Qualifying exemption or special regime",
          kind: "flag",
          decimals: 0,
          min: "0",
          max: "1",
          required: false,
          help:
            "Select only when the employer is covered by an exemption/special regime listed by URSSAF; ordinary employers remain at 5.25%.",
        },
      ],
    },
  ],
};
