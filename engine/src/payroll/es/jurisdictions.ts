/**
 * The ES pack's holiday calendar: the national fiestas laborales.
 *
 * Estatuto de los Trabajadores, art. 37.2 (RD Legislativo 2/2015): up to 14
 * paid, non-recoverable holidays a year. This list transcribes the dates
 * shared nationally in the BOE's 2026 relation; community-specific and
 * municipal holidays remain untranscribed — see the ledger.
 *
 * The nationally observed fiestas include Epifanía del Señor (6-1) in the
 * BOE's 2026 relation, as well as Año Nuevo (1-1), Viernes Santo,
 * Fiesta del Trabajo (1-5), Asunción (15-8),
 * Fiesta Nacional (12-10), Todos los Santos (1-11), Constitución (6-12),
 * Inmaculada (8-12), Navidad (25-12).
 *
 * One entry per community (`ES-<code>`), all sharing the national fiestas:
 * every profile names its community, so the engine resolves
 * jurisdictionKey("ES", "<code>") = "ES-<code>" and a bare "ES" key would
 * declare a calendar no employee reaches — the undeclared-jurisdiction gate
 * would then refuse every period containing a mandatory holiday (DE precedent:
 * per-Land keys). Each entry's name says "fiestas nacionales" so no reader
 * mistakes it for the community's full calendar.
 *
 * `observance: "none"`: the national calendar does not move a fiesta that
 * lands on a weekend — when one does, the communities may add a substitute
 * day, which is THEIR declaration, not this one's.
 *
 * `holidayPay` is null: ET art. 37.2 mandates a paid, non-recoverable day,
 * but the irregular-hours formula lives in convenios (untranscribed). A
 * PLACEHOLDER average-day lookback would COMPUTE a number nobody sourced.
 * Null refuses until a sourced formula lands — same posture as IT.
 */
import type { PayrollJurisdiction } from "../pack-types.ts";

/**
 * The 19 autonomous communities and cities, code plus the community's own
 * Spanish proper noun as the Instituto Nacional de Estadística (INE) lists
 * it. The single source for the pack's region names — pack.ts derives its
 * region coverage from this, beside the coverage that reads it, so no
 * generic layer maps codes to names.
 */
export const ES_COMUNIDADES: readonly { code: string; name: string }[] = [
  { code: "AN", name: "Andalucía" },
  { code: "AR", name: "Aragón" },
  { code: "AS", name: "Asturias" },
  { code: "CN", name: "Canarias" },
  { code: "CB", name: "Cantabria" },
  { code: "CL", name: "Castilla y León" },
  { code: "CM", name: "Castilla-La Mancha" },
  { code: "CT", name: "Cataluña" },
  { code: "EX", name: "Extremadura" },
  { code: "GA", name: "Galicia" },
  { code: "IB", name: "Illes Balears" },
  { code: "RI", name: "La Rioja" },
  { code: "MD", name: "Madrid" },
  { code: "MC", name: "Murcia" },
  { code: "NC", name: "Navarra" },
  { code: "PV", name: "País Vasco" },
  { code: "VC", name: "Comunitat Valenciana" },
  { code: "CE", name: "Ceuta" },
  { code: "ML", name: "Melilla" },
];

/** The 2026 relation's national fiestas shared by every community. */
const ES_FIESTAS_NACIONALES: PayrollJurisdiction["holidays"] = [
  { key: "ano_nuevo", name: "Año Nuevo", rule: { kind: "fixed", month: 1, day: 1 }, observance: "none" },
  { key: "epifania", name: "Epifanía del Señor", rule: { kind: "fixed", month: 1, day: 6 }, observance: "none" },
  { key: "viernes_santo", name: "Viernes Santo", rule: { kind: "easter_offset", days: -2 }, observance: "none" },
  { key: "fiesta_trabajo", name: "Fiesta del Trabajo", rule: { kind: "fixed", month: 5, day: 1 }, observance: "none" },
  { key: "asuncion", name: "Asunción de la Virgen", rule: { kind: "fixed", month: 8, day: 15 }, observance: "none" },
  { key: "fiesta_nacional", name: "Fiesta Nacional de España", rule: { kind: "fixed", month: 10, day: 12 }, observance: "none" },
  { key: "todos_santos", name: "Todos los Santos", rule: { kind: "fixed", month: 11, day: 1 }, observance: "none" },
  { key: "constitucion", name: "Día de la Constitución", rule: { kind: "fixed", month: 12, day: 6 }, observance: "none" },
  { key: "inmaculada", name: "Inmaculada Concepción", rule: { kind: "fixed", month: 12, day: 8 }, observance: "none" },
  { key: "navidad", name: "Natividad del Señor", rule: { kind: "fixed", month: 12, day: 25 }, observance: "none" },
];

function esJurisdiction(code: string, name: string): PayrollJurisdiction {
  return {
    // The key is the profile-resolved jurisdiction, not the bare country:
    // jurisdictionKey("ES", "MD") is "ES-MD" (every profile names its
    // community, so the bare country never resolves). A bare "ES" key
    // declares a calendar no employee can ever reach, and the
    // undeclared-jurisdiction gate then refuses every period containing a
    // mandatory holiday. The foral NC/PV resolve here too — their IRPF
    // refusal lives in compute-statutory, not in the holiday calendar.
    key: `ES-${code}`,
    name: `España (fiestas nacionales) — ${name}`,
    scope: "employment",
    citation:
      "Estatuto de los Trabajadores, art. 37.2; BOE Resolución de 17 octubre 2025, calendario laboral 2026: https://www.boe.es/eli/es/res/2025/10/17/%282%29",
    holidays: [...ES_FIESTAS_NACIONALES],
    holidayPay: null,
  };
}

export const ES_JURISDICTIONS: readonly PayrollJurisdiction[] = ES_COMUNIDADES.map(
  (comunidad) => esJurisdiction(comunidad.code, comunidad.name),
);
