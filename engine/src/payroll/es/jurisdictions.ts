/**
 * The ES pack's holiday calendar: the national fiestas laborales.
 *
 * Estatuto de los Trabajadores, art. 37.2 (RD Legislativo 2/2015): up to 14
 * paid, non-recoverable holidays a year — 9 national, the rest set by each
 * autonomous community (and 2 by each municipality). Only the 9 NATIONAL dates
 * are declared here; the 17 community calendars (published yearly in the BOE)
 * and the municipal days are untranscribed — see the ledger.
 *
 * The 9 national fiestas (fixed every year except Good Friday):
 * Año Nuevo (1-1), Viernes Santo, Fiesta del Trabajo (1-5), Asunción (15-8),
 * Fiesta Nacional (12-10), Todos los Santos (1-11), Constitución (6-12),
 * Inmaculada (8-12), Navidad (25-12).
 *
 * `observance: "none"`: the national calendar does not move a fiesta that
 * lands on a weekend — when one does, the communities may add a substitute
 * day, which is THEIR declaration, not this one's.
 *
 * `holidayPay` is the ET art. 37.2 rule itself: the day is paid at the normal
 * day's salary (`normal_day`). The `whenIrregular` arm is flagged honestly —
 * the ET states no varying-hours fallback (that lives in the convenios
 * colectivos, untranscribed), so the declaration carries an average-day
 * lookback as a marked placeholder pending convenio transcription, not as
 * statute. No premium is mandated at statute level (`multiplier: "1"`,
 * `plusHolidayPay: true`: the paid day plus the hours' normal pay).
 */
import type { PayrollJurisdiction } from "../packs.ts";

export const ES_JURISDICTIONS: readonly PayrollJurisdiction[] = [
  {
    key: "ES",
    name: "España (fiestas nacionales)",
    scope: "employment",
    citation:
      "Estatuto de los Trabajadores, art. 37.2 (RD Legislativo 2/2015); calendario anual (BOE)",
    holidays: [
      { key: "ano_nuevo", name: "Año Nuevo", rule: { kind: "fixed", month: 1, day: 1 }, observance: "none" },
      { key: "viernes_santo", name: "Viernes Santo", rule: { kind: "easter_offset", days: -2 }, observance: "none" },
      { key: "fiesta_trabajo", name: "Fiesta del Trabajo", rule: { kind: "fixed", month: 5, day: 1 }, observance: "none" },
      { key: "asuncion", name: "Asunción de la Virgen", rule: { kind: "fixed", month: 8, day: 15 }, observance: "none" },
      { key: "fiesta_nacional", name: "Fiesta Nacional de España", rule: { kind: "fixed", month: 10, day: 12 }, observance: "none" },
      { key: "todos_santos", name: "Todos los Santos", rule: { kind: "fixed", month: 11, day: 1 }, observance: "none" },
      { key: "constitucion", name: "Día de la Constitución", rule: { kind: "fixed", month: 12, day: 6 }, observance: "none" },
      { key: "inmaculada", name: "Inmaculada Concepción", rule: { kind: "fixed", month: 12, day: 8 }, observance: "none" },
      { key: "navidad", name: "Natividad del Señor", rule: { kind: "fixed", month: 12, day: 25 }, observance: "none" },
    ],
    holidayPay: [
      {
        effectiveFrom: null,
        effectiveTo: null,
        rule: {
          citation: "ET art. 37.2: fiestas laborales de carácter retribuido y no recuperable",
          basis: {
            kind: "normal_day",
            // PLACEHOLDER, not statute: the ET states no varying-hours
            // fallback — convenios colectivos govern it and are untranscribed.
            whenIrregular: { kind: "average_day", lookbackDays: 30, counting: "worked" },
          },
          include: { overtime: false, vacationPay: false, holidayPay: false },
          qualifying: { lastAndFirstScheduledShift: false },
          premium: { multiplier: "1", plusHolidayPay: true },
          lookbackEnds: { kind: "day_before" },
        },
      },
    ],
  },
];
