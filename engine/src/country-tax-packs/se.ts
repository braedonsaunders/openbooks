import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const SE_MOMSDEKLARATION_2026: TaxReturnPack = {
  code: "SE_MOMSDEKLARATION",
  name: "Momsdeklaration — mervärdesskattedeklaration",
  country: "SE",
  jurisdiction: { code: "SE", name: "Sweden", country: "SE", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.skatteverket.se/foretag/moms/deklareramoms.4.7459477810df5bccdd480006935.html",
  watermark: "Working copy — confirm the filing period on Mina sidor, then file through the Skatteverket e-service",
  boxes: [
    { lineCode: "05", label: "Ruta 05 — momspliktig försäljning exklusive moms (exkl. ruta 06, 07, 08)", sign: 1, sequence: 10 },
    { lineCode: "06", label: "Ruta 06 — momspliktiga uttag", sign: 1, sequence: 20 },
    { lineCode: "07", label: "Ruta 07 — beskattningsunderlag vid vinstmarginalbeskattning", sign: 1, sequence: 30 },
    { lineCode: "08", label: "Ruta 08 — hyresinkomster vid frivillig skattskyldighet", sign: 1, sequence: 40 },
    { lineCode: "10", label: "Ruta 10 — utgående moms 25 % på försäljning eller uttag i ruta 05–08", sign: -1, sequence: 50 },
    { lineCode: "11", label: "Ruta 11 — utgående moms 12 % på försäljning eller uttag i ruta 05–08", sign: -1, sequence: 60 },
    { lineCode: "12", label: "Ruta 12 — utgående moms 6 % på försäljning eller uttag i ruta 05–08", sign: -1, sequence: 70 },
    { lineCode: "48", label: "Ruta 48 — ingående moms att dra av", sign: 1, sequence: 80 },
    { lineCode: "49", label: "Ruta 49 — moms att betala eller få tillbaka", sign: 1, sequence: 90 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 100, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 110, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Sweden moms localization.
 *
 * Currency is SEK; the pack carries no currency field. Moms is national —
 * kommuner and regioner levy income tax, not VAT — so jurisdictions is empty.
 * The default filing period is quarterly, but Skatteverket assigns monthly,
 * quarterly, or annual filing by turnover; the pack does not model that
 * threshold. Rate histories run back to 2019-07-01, one row per rate change:
 * SFS 2019:261 restates 7 kap. 1 § mervärdesskattelagen (1994:200) with the
 * 25/12/6 bands in force from 2019-07-01, its 12% list already covering
 * hotels, food, restaurant/catering and repairs and its 6% list books and
 * papers — the same scope the codes carry today, outside the temporary food
 * window below. Unchanged values were verified forward through the SFS
 * 2022:413 restatement (in force 2022-07-01) and the SFS 2023:80 restatement
 * (in force 2023-04-01), which are named here rather than cited, and across
 * the 2023 recast: SFS 2023:200 (nya mervärdesskattelagen) entered into force
 * 2023-07-01 repealing the 1994:200 act with identical 25/12/6 values, and
 * no 2024–2025 act amends the rate values — the 2026 acts touch 9 kap food
 * scope only. SFS 2023:200 stays in the sources as the live instrument;
 * rows cite the earliest attestation. These are continuing-authority rows —
 * permanent statute restated and recast, not temporary-instrument renewals —
 * so equal values collapse to one row; the temporary food window stays its
 * own code. Pre-2019 is a named refusal: the previous restatement
 * (SFS 2017:1205) is not retrievable from svenskforfattningssamling.se under
 * its stable path scheme, so the chain stops at 2019:261 rather than
 * bridging the gap.
 *
 * The temporary food-rate cut is a SEPARATE code, not a closed interval on
 * SE-VAT-RED12: the 12% band covers food, restaurant meals and hotels, but
 * the cut (SFS 2026:118, 9 kap. 19 §) moves only food — including bottled
 * water for sale, excluding drinking-water-directive water and
 * spirits/wine/strong beer — to 6% from 2026-04-01. Restaurant meals and
 * hotels stay at 12%, so SE-VAT-RED12 stays open-ended and still covers
 * today. The window end, 2027-12-31, is attested by the enacted reverting
 * act SFS 2026:119, which taxes the same foods at 12% again from
 * 2028-01-01. Output tax for the 6% food band is reported in ruta 12, which
 * already exists on the return.
 *
 * No zero-rated code: the declaration's output-tax rutor are 25/12/6% only,
 * with exempt sales in section E — there is no zero-rated band on the return
 * to line a code up with.
 */
export const SWEDEN_TAX_PACK: CountryTaxPackDefinition = {
  code: "SE_INDIRECT_TAX",
  version: "2026.08.01",
  country: "SE",
  name: "Sweden",
  countryTaxType: "vat",
  parentReturnPackCode: "SE_MOMSDEKLARATION",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "skatteverket_momsdeklaration_form",
      title: "Skatteverket — Momsdeklaration form (SKV 4700): rutor 05–08, 10–12, 48, 49",
      url: "https://www.skatteverket.se/download/18.6e8a1495181dad54084e09/1661520584882/momsdeklaration",
      asOf: "2026-09-18",
    },
    {
      id: "skatteverket_vat_return_english",
      title: "Skatteverket — VAT return English translation: box labels for sections A, B, F, G",
      url: "https://www.skatteverket.se/download/18.7be5268414bea064694a4b5/1430837196910/4700-engelsk-oversattning-moms-2015.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "skatteverket_deklarera_moms",
      title: "Skatteverket — Deklarera moms: e-service filing with monthly, quarterly, or annual periods",
      url: "https://www.skatteverket.se/foretag/moms/deklareramoms.4.7459477810df5bccdd480006935.html",
      asOf: "2026-09-18",
    },
    {
      id: "skatteverket_rates_applicability_2026",
      title: "Skatteverket — VAT rates applicable for income year 2026: general 25%, 12% and 6% bands with examples (applicability, not origin)",
      url: "https://www.skatteverket.se/download/18.70685bee19c85dd5dd03acd/1775022844839/belopp-och-procentsatser-for-inkomstaret-2026-lagandringar-1-april.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "sfs_2026_118_food_6_temp",
      title: "SFS 2026:118 (Prop. 2025/26:55, bet. 2025/26:SkU9, rskr. 2025/26:158) — 9 kap. 19 § taxes food at 6% from 2026-04-01, bottled water for sale included, drinking-water-directive water and spirits/wine/strong beer excluded",
      url: "https://svenskforfattningssamling.se/sites/default/files/sfs/2026-02/SFS2026-118.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "sfs_2026_119_food_12_revert",
      title: "SFS 2026:119 — the same foods taxed at 12% again from 2028-01-01, attesting the temporary 6% window ends 2027-12-31",
      url: "https://svenskforfattningssamling.se/sites/default/files/sfs/2026-02/SFS2026-119.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "sfs_2019_261_rates_origin",
      title: "SFS 2019:261 — 7 kap. 1 § mervärdesskattelagen (1994:200): 25/12/6 bands (hotels, food, restaurant/catering, repairs at 12%; books and papers at 6%) in force from 2019-07-01",
      url: "https://svenskforfattningssamling.se/sites/default/files/sfs/2019-05/SFS2019-261.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "sfs_2023_200_recast",
      title: "SFS 2023:200 — nya mervärdesskattelagen: recast in force 2023-07-01 repealing the 1994:200 act with identical 25/12/6 values; live instrument, no row cites it",
      url: "https://svenskforfattningssamling.se/sites/default/files/sfs/2023-04/SFS2023-200.pdf",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [SE_MOMSDEKLARATION_2026],
  returnPackTaxCodes: {
    SE_MOMSDEKLARATION: [
      {
        code: "SE-VAT-STD",
        name: "Sweden standard VAT 25%",
        ratePercent: 25,
        role: "standard",
        rates: [{ ratePercent: 25, effectiveFrom: "2019-07-01", sourceId: "sfs_2019_261_rates_origin" }],
      },
      {
        code: "SE-VAT-RED12",
        name: "Sweden reduced VAT 12% — restaurant meals, hotels (and food outside the 2026-04-01–2027-12-31 temporary 6% window)",
        ratePercent: 12,
        role: "reduced",
        rates: [{ ratePercent: 12, effectiveFrom: "2019-07-01", sourceId: "sfs_2019_261_rates_origin" }],
      },
      {
        code: "SE-VAT-FOOD6",
        name: "Sweden temporary food VAT 6% — food and bottled water for sale only, 2026-04-01 through 2027-12-31 (SFS 2026:118; reverts to 12% per SFS 2026:119)",
        ratePercent: 6,
        role: "reduced",
        rates: [{ ratePercent: 6, effectiveFrom: "2026-04-01", effectiveTo: "2027-12-31", sourceId: "sfs_2026_118_food_6_temp" }],
      },
      {
        code: "SE-VAT-RED6",
        name: "Sweden reduced VAT 6% — books, newspapers, passenger transport, cultural admissions",
        ratePercent: 6,
        role: "reduced",
        rates: [{ ratePercent: 6, effectiveFrom: "2019-07-01", sourceId: "sfs_2019_261_rates_origin" }],
      },
    ],
  },
};
