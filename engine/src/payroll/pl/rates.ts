/**
 * Poland — statutory-table editions.
 *
 * Calendar 2026 is transcribed (PIT skala + monthly advances, ZUS/NFZ
 * rates and split, the 282 600 zł annual base limit, FP/FS/FGŚP 2026 rates,
 * the 4 806 zł minimum wage — see ./tables-2026.ts for the instruments).
 * The monthly PIT-2-filed employment payslip with standard contributions
 * computes end to end, proven by the parity harnesses. Tenant-declared
 * wypadkowe has no engine channel and the named variants stay refused
 * (see PL_REFUSALS_2026).
 */
import type { PayrollTaxYearSupport } from "../tax-years.ts";

export const PL_TAX_YEARS: PayrollTaxYearSupport = {
  country: "PL",
  editions: [
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
        template: "",
      },
    ],
    barrels: [],
    steps: [
      "Transcribe the PIT skala and advance rules from the ustawa o podatku dochodowym od osób fizycznych (isap/sejm Dziennik Ustaw).",
      "Transcribe the year's ZUS rates and annual base limit (obwieszczenie MRPiPS) and the FP/FS/FGŚP rates (ustawa budżetowa).",
      "Add the edition to PL_TAX_YEARS with status \"published\" and the agency citation.",
      "Add a golden stub test proving the transcribed figures calculate.",
    ],
  },
};
