/**
 * Poland — statutory-table editions.
 *
 * Calendar 2024, 2025 and 2026 are transcribed (PIT skala + monthly
 * advances, ZUS/NFZ rates and split, the year's annual base limit, FP/FS
 * 1,0 %/1,45 % + FGŚP 0,10 % fund rates, the year's minimum wage — see
 * ./tables-{2024,2025,2026}.ts for the instruments). The monthly
 * PIT-2-filed employment payslip with standard contributions computes end
 * to end in every transcribed year, proven by the parity harnesses.
 * Tenant-declared wypadkowe has no engine channel and the named variants
 * stay refused (see PL_REFUSALS_{2024,2025,2026}).
 *
 * Year differences the engine models as data: the annual base limit
 * (234 720 / 260 190 / 282 600 zł), the minimum wage (4 242 → 4 300 zł
 * on 1 July 2024; 4 666 zł; 4 806 zł), and the FGŚP 55/60 age bar
 * (modelled for 2024/2025, landed-unconditional for 2026 — reported).
 */
import type { PayrollTaxYearSupport } from "../tax-years.ts";

export const PL_TAX_YEARS: PayrollTaxYearSupport = {
  country: "PL",
  editions: [
    {
      year: 2024,
      label: "Skala 2024 + składki ZUS/NFZ/FP/FS/FGŚP 2024 (Dz.U. 2024 poz. 226; Dz.U. 2024 poz. 497; Dz.U. 2024 poz. 146; Dz.U. 2024 poz. 122; M.P. 2023 poz. 1356; Dz.U. 2023 poz. 1893)",
      effectiveFrom: "2024-01-01",
      citation:
        "updof tekst jedn. Dz.U. 2024 poz. 226 (art. 22, 27, 31b, 32; art. 27b uchylony); "
        + "sus 2024 Dz.U. 2024 poz. 497 (art. 16, 19, 22); ustawa o "
        + "świadczeniach zdrowotnych Dz.U. 2024 poz. 146 (art. 79, 81); "
        + "ustawa budżetowa 2024 Dz.U. 2024 poz. 122 (art. 24, 26–28); "
        + "obwieszczenie MRiPS M.P. 2023 poz. 1356 (limit 234 720 zł); "
        + "rozp. RM Dz.U. 2023 poz. 1893 (minimalne 4 242 zł / 4 300 zł od 1 lipca)",
      status: "published",
    },
    {
      year: 2025,
      label: "Skala 2025 + składki ZUS/NFZ/FP/FS/FGŚP 2025 (Dz.U. 2025 poz. 163; Dz.U. 2025 poz. 350; Dz.U. 2025 poz. 1461; Dz.U. 2025 poz. 63; M.P. 2024 poz. 1051; Dz.U. 2024 poz. 1362)",
      effectiveFrom: "2025-01-01",
      citation:
        "updof tekst jedn. Dz.U. 2025 poz. 163 (art. 22, 27, 31b, 32; art. 27b uchylony); "
        + "sus 2025 Dz.U. 2025 poz. 350 (art. 16, 19, 22); ustawa o "
        + "świadczeniach zdrowotnych Dz.U. 2025 poz. 1461 (art. 79, 81); "
        + "ustawa budżetowa 2025 Dz.U. 2025 poz. 63 (art. 24–27); "
        + "obwieszczenie MRPiPS M.P. 2024 poz. 1051 (limit 260 190 zł); "
        + "rozp. RM Dz.U. 2024 poz. 1362 (minimalne 4 666 zł)",
      status: "published",
    },
    {
      year: 2026,
      label: "Skala 2026 + składki ZUS/NFZ/FP 2026 (Dz.U. 2025 poz. 163; Dz.U. 2026 poz. 199; Dz.U. 2026 poz. 62; M.P. 2025 poz. 1206)",
      effectiveFrom: "2026-01-01",
      citation:
        "updof tekst jedn. Dz.U. 2025 poz. 163 (art. 22, 27, 31b, 32); "
        + "sus 2026 Dz.U. 2026 poz. 199 (art. 16, 19, 22); ustawa o "
        + "świadczeniach zdrowotnych Dz.U. 2025 poz. 1461 (art. 79, 81); "
        + "ustawa budżetowa 2026 Dz.U. 2026 poz. 62 (art. 24–27); "
        + "obwieszczenie MRPiPS M.P. 2025 poz. 1206 (limit 282 600 zł); "
        + "rozp. RM Dz.U. 2025 poz. 1242 (minimalne 4 806 zł)",
      status: "published",
    },
  ],
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/pl/rates.ts",
  scaffold: {
    files: [
      {
        path: "engine/src/payroll/pl/tables-{year}.ts",
        purpose: "Transcribed PIT scale, advance rules and ZUS/NFZ/FP parameters for the year.",
        template:
          "/**\n"
          + " * Transcribed Polish statutory tables for calendar year {year}.\n"
          + " *\n"
          + " * Replace every UNFILLED figure below with the authority's published\n"
          + " * number and its quoted operative sentence (prior edition: tables-{priorYear}.ts).\n"
          + " * Until then the edition stays draft and every engine refuses it by name.\n"
          + " */\n"
          + "import type { PlRate } from \"./tables-2026.ts\";\n"
          + "export const PL_PIT_SKALA_{year} = {\n"
          + "  prog: \"UNFILLED\",\n"
          + "  stawkaDolna: { rate: \"UNFILLED\", quote: \"UNFILLED\" },\n"
          + "  kwotaZmniejszajaca: \"UNFILLED\",\n"
          + "  podatekOdProgu: \"UNFILLED\",\n"
          + "  stawkaGorna: { rate: \"UNFILLED\", quote: \"UNFILLED\" },\n"
          + "} as const;\n"
          + "export const PL_ROCZNY_LIMIT_{year} = {\n"
          + "  annual: \"UNFILLED\",\n"
          + "  prognozowane: \"UNFILLED\",\n"
          + "  quote: \"UNFILLED\",\n"
          + "} as const;\n"
          + "export const PL_ZDROWOTNA_{year}: PlRate = { rate: \"UNFILLED\", quote: \"UNFILLED\" };\n"
          + "export const PL_MIN_WAGE_{year} = { monthly: \"UNFILLED\", quote: \"UNFILLED\" } as const;\n"
          + "export const PL_REFUSALS_{year}: readonly string[] = [\"UNFILLED\"];\n",
      },
    ],
    barrels: [],
    steps: [
      "Transcribe the PIT skala and advance rules from the ustawa o podatku dochodowym od osób fizycznych (isap/sejm Dziennik Ustaw).",
      "Transcribe the year's ZUS rates and annual base limit (obwieszczenie MRPiPS) and the FP/FS/FGŚP rates (ustawa budżetowa).",
      "Check whether any figure changed mid-year (the minimum wage did on 1.7.2024: one regulation, two effective dates — carried as a dated value inside one edition, not two editions) and whether the FGŚP 55/60 age bar still holds for the year.",
      "Add the edition to PL_TAX_YEARS with status \"published\" and the agency citation.",
      "Add a golden stub test proving the transcribed figures calculate, plus a cross-year case proving the new year prices differently from its neighbours.",
    ],
  },
};
