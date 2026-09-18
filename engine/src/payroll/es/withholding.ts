/**
 * The ES pack's withholding jurisdictions: IRPF by autonomous community.
 *
 * Region codes are ISO 3166-2:ES (without the `ES-` prefix): the same
 * granularity the AEAT withholding algorithm works at, and the granularity at
 * which the foral regimes diverge.
 *
 * NOTHING is implemented: the 2026 AEAT retention algorithm
 * (https://www3.agenciatributaria.gob.es/static_files/Sede/Programas_ayuda/Retenciones/2026/ALGORITMO_2026.pdf,
 * portal https://sede.agenciatributaria.gob.es/Sede/Retenciones.shtml) is not
 * transcribed, so every region below is `implemented: false` with the reason
 * naming what is missing. The foral territories — Navarra (Hacienda Foral de
 * Navarra) and the three Basque Historical Territories, Álava/Araba, Gipuzkoa
 * and Bizkaia (Haciendas Forales) — publish their OWN retention tables (e.g.
 * Bizkaia's 2026 table:
 * https://www.bizkaia.eus/documents/26740887/26976067/tabla-de-retenciones-2026-01.pdf),
 * so they are refused by name rather than covered by any AEAT transcription.
 *
 * Non-residents are outside IRPF entirely: they fall under the Impuesto sobre
 * la Renta de No Residentes (LIRNR, RD Legislativo 5/2004), which no pack
 * engine computes — hence `taxesNonresidentWages: false` everywhere below.
 */
import type {
  PayrollPackWithholding,
  PayrollRegionWithholding,
} from "../withholding-jurisdictions.ts";

const ES_REGION_CODES = [
  "AN", "AR", "AS", "CN", "CB", "CL", "CM", "CT", "EX", "GA",
  "IB", "RI", "MD", "MC", "NC", "PV", "VC", "CE", "ML",
] as const;

const ES_REGION_NAMES: Readonly<Record<string, string>> = {
  AN: "Andalucía",
  AR: "Aragón",
  AS: "Asturias",
  CN: "Canarias",
  CB: "Cantabria",
  CL: "Castilla y León",
  CM: "Castilla-La Mancha",
  CT: "Cataluña",
  EX: "Extremadura",
  GA: "Galicia",
  IB: "Illes Balears",
  RI: "La Rioja",
  MD: "Madrid",
  MC: "Murcia",
  NC: "Navarra",
  PV: "País Vasco",
  VC: "Comunitat Valenciana",
  CE: "Ceuta",
  ML: "Melilla",
};

const AEAT_UNIMPLEMENTED =
  "IRPF withholding is not implemented by the ES payroll pack — the AEAT retention algorithm "
  + "for the year (ALGORITMO, Sede/Retenciones) is not transcribed into engine/src/payroll/es/rates.ts";

const FORAL_REASONS: Readonly<Record<string, string>> = {
  NC: "Navarra applies the foral IRPF regime (Hacienda Foral de Navarra publishes its own "
    + "retention tables) — AEAT tables never cover it and are not transcribed either",
  PV: "the Basque Historical Territories — Álava/Araba, Gipuzkoa and Bizkaia — apply the foral "
    + "IRPF regime (each Hacienda Foral publishes its own retention tables; e.g. Bizkaia's 2026 "
    + "table) — AEAT tables never cover them and are not transcribed either",
};

const ES_REGIONS: readonly PayrollRegionWithholding[] = ES_REGION_CODES.map(
  (region): PayrollRegionWithholding => ({
    region,
    label: `IRPF (${ES_REGION_NAMES[region]})`,
    implemented: false,
    unimplementedReason: FORAL_REASONS[region] ?? AEAT_UNIMPLEMENTED,
    // Rendimientos del trabajo de no residentes tributan por el IRNR
    // (RD Legislativo 5/2004), no por el IRPF.
    taxesNonresidentWages: false,
    // Whether the AEAT requires withholding on a resident's wages earned in
    // another community, and with what credit, is not established — refused
    // rather than defaulted.
    residentWithholding: "unknown",
    residentWithholdingImplemented: false,
    certificateKey: "es_145",
    subRegions: [],
    subRegionConflictRule: "work_only",
    citation: "LIRPF (Ley 35/2006); RIRPF (RD 439/2007); LIRNR (RD Legislativo 5/2004)",
  }),
);

export const ES_WITHHOLDING: PayrollPackWithholding = {
  country: "ES",
  regions: ES_REGIONS,
};
