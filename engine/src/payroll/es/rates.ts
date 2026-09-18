/**
 * The ES pack's statutory tables: IRPF retention algorithm + Seguridad Social.
 *
 * NOTHING IS TRANSCRIBED. The 2026 AEAT algorithm was fetched (not memorised):
 * https://www3.agenciatributaria.gob.es/static_files/Sede/Programas_ayuda/Retenciones/2026/ALGORITMO_2026.pdf
 * (portal: https://sede.agenciatributaria.gob.es/Sede/Retenciones.shtml).
 * Transcribing it is a sourced-table pass of its own (situación-familiar
 * brackets by income, hijos reductions, exclusion limits TABLA 1) — this
 * skeleton refuses 2026 BY NAME instead of guessing bands.
 *
 * Seguridad Social 2026 (Orden PJC/297/2026, BOE 30-3-2026, effects 1-1-2026):
 * contingencias comunes 28,30% (23,60% empresa / 4,70% trabajador), MEI 0,90%
 * (0,75% / 0,15%) — also untranscribed, pending the same pass. Portal:
 * https://www.seg-social.es/wps/portal/wss/internet/Trabajadores/CotizacionRecaudacionTrabajadores/9896/11301/11302/12703
 *
 * `editions` is therefore empty: `payrollTaxYearProblem("ES", 2026)` reports
 * `kind: "missing"` naming 2026 and this module. Navarra and País Vasco are
 * `regionsWithOwnTables` because the foral Haciendas publish separately — a
 * year is loaded for them only when a foral edition exists.
 *
 * `slots` is empty for a different reason: every ES statutory rate is a
 * PUBLISHED constant (AEAT algorithm, TGSS bases/tipos, tarifa de primas de
 * AT/EP), never an employer-assigned value like a SUI experience rate — so
 * there is no tenant-supplied slot to declare. Rates land as pack constants in
 * this module when transcribed, not as `payroll_statutory_rates` rows.
 */
import type { PayrollTaxYearSupport } from "../tax-years.ts";
import type { PayrollPackRates } from "../statutory-rates.ts";

export const ES_RATES_MODULE = "engine/src/payroll/es/rates.ts";

export const ES_TAX_YEARS: PayrollTaxYearSupport = {
  country: "ES",
  editions: [],
  regionsWithOwnTables: ["NC", "PV"],
  ratesModule: ES_RATES_MODULE,
  scaffold: {
    files: [
      {
        path: ES_RATES_MODULE,
        purpose: "AEAT retention algorithm editions + TGSS contribution bases/tipos, versioned by year",
        template:
          "Transcribe the AEAT ALGORITMO for {year} (Sede/Programas_ayuda/Retenciones/{year}/) "
          + "and the TGSS Orden de cotización for {year}, beside the {priorYear} edition.",
      },
    ],
    barrels: [],
    steps: [
      "Fetch the AEAT ALGORITMO for the year from Sede/Programas_ayuda/Retenciones and transcribe "
        + "the situación-familiar brackets, TABLA 1 exclusion limits, and hijos reductions.",
      "Transcribe the TGSS Orden de cotización (bases mínimas/máximas, tipos empresa/trabajador, MEI).",
      "Transcribe or explicitly refuse the foral tables (Navarra; Álava/Araba, Gipuzkoa, Bizkaia).",
      "Add golden stubs and flip the pack to installable.",
    ],
  },
};

export const ES_PACK_RATES: PayrollPackRates = {
  country: "ES",
  slots: [],
};
