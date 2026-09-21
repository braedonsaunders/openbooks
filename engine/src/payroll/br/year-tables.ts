/**
 * BR prior-year edition selector: which transcribed tables price a pay date.
 *
 * Both 2024 and 2025 changed the IRRF monthly table mid-year while the INSS
 * table held all year (the January portaria), so each year has one INSS
 * table and two IRRF editions. The selector returns the bundle in force for
 * the pay month — the ES `ratesForPayDate` precedent's shape. It throws for
 * any date outside the transcribed year: never extrapolate, never clamp to
 * the nearest table.
 *
 * Boundaries (each cited on the year module):
 * - 2024-02-01: Lei 14.848/2024 item XI "a partir do mês de fevereiro";
 *   January runs Lei 14.663/2023 item X ("May 2023–January 2024" per RFB).
 * - 2025-05-01: Lei 15.191/2025 item XII "a partir do mês de maio";
 *   January–April runs Lei 14.848/2024 item XI (RFB: "De janeiro a abril").
 */
import { PayrollPackError } from "../payroll-error.ts";
import type { BrInssTables } from "./inss-year.ts";
import type { BrIrrfTables } from "./irrf-year.ts";
import {
  BR_2024_DEPENDENTE,
  BR_2024_FGTS,
  BR_2024_INSS_BRACKETS,
  BR_2024_INSS_TETO,
  BR_2024_IRRF_FEB,
  BR_2024_IRRF_JAN,
  BR_2024_PATRONAL,
} from "./tax-year-2024.ts";
import {
  BR_2025_DEPENDENTE,
  BR_2025_FGTS,
  BR_2025_INSS_BRACKETS,
  BR_2025_INSS_TETO,
  BR_2025_IRRF_EARLY,
  BR_2025_IRRF_LATE,
  BR_2025_PATRONAL,
} from "./tax-year-2025.ts";

/** Every transcribed table a prior-year monthly payslip prices through. */
export interface BrYearTables {
  inss: BrInssTables;
  irrf: BrIrrfTables;
  /** The IRRF edition label, for traces and the edition tests. */
  irrfLabel: string;
  /** Employer INSS patronal percent ("20" — Lei 8.212/1991 art. 22, I, every year). */
  patronal: string;
  /** FGTS percent ("8" — Lei 8.036/1990 art. 15, every year). */
  fgts: string;
}

export function brTablesForPayDate(year: 2024 | 2025, payDate: string): BrYearTables {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    throw new PayrollPackError(`BR payroll: pay date is not an ISO date: "${payDate}"`);
  }
  if (payDate < `${year}-01-01` || payDate > `${year}-12-31`) {
    throw new PayrollPackError(
      `BR payroll: no transcribed tables for pay date ${payDate} — ${year} covers `
      + `${year}-01-01..${year}-12-31. Transcribe the year's Portaria + monthly tables first`,
    );
  }
  if (year === 2024) {
    const irrf = payDate < "2024-02-01" ? BR_2024_IRRF_JAN : BR_2024_IRRF_FEB;
    return {
      inss: { brackets: BR_2024_INSS_BRACKETS, teto: BR_2024_INSS_TETO, tag: "BR 2024 INSS" },
      irrf: {
        bands: irrf.bands,
        simplificado: irrf.simplificado,
        dependente: BR_2024_DEPENDENTE,
        tag: `BR 2024 IRRF (${payDate < "2024-02-01" ? "jan" : "feb-dec"})`,
      },
      irrfLabel: irrf.label,
      patronal: BR_2024_PATRONAL,
      fgts: BR_2024_FGTS,
    };
  }
  const irrf = payDate < "2025-05-01" ? BR_2025_IRRF_EARLY : BR_2025_IRRF_LATE;
  return {
    inss: { brackets: BR_2025_INSS_BRACKETS, teto: BR_2025_INSS_TETO, tag: "BR 2025 INSS" },
    irrf: {
      bands: irrf.bands,
      simplificado: irrf.simplificado,
      dependente: BR_2025_DEPENDENTE,
      tag: `BR 2025 IRRF (${payDate < "2025-05-01" ? "jan-apr" : "may-dec"})`,
    },
    irrfLabel: irrf.label,
    patronal: BR_2025_PATRONAL,
    fgts: BR_2025_FGTS,
  };
}
