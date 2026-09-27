import { addCalendarDays, addMonthsClamped, civilDateFromParts, daysInCivilMonth, parseIsoDate } from "../platform/civil-date.ts";
import type { SourceEntity } from "./source.ts";

export type ImportedLockState = "open" | "soft_closed" | "closed";
export type ImportedModuleStates = Partial<Record<"ar" | "ap" | "banking" | "assets" | "tax" | "gl", ImportedLockState>>;

export interface SourceFiscalYear {
  key: string;
  fiscalYear: number;
  startsOn: string;
  endsOn: string;
}

/** Build exact monthly posting periods inside source fiscal-year boundaries. */
export function monthlySourcePeriods(
  prefix: string,
  years: SourceFiscalYear[],
  stateForEnd: (endsOn: string) => ImportedModuleStates,
): SourceEntity[] {
  const out: SourceEntity[] = [];
  for (const year of years) {
    let cursor = year.startsOn;
    const fiscalEnd = year.endsOn;
    let periodNumber = 0;
    while (cursor <= fiscalEnd) {
      periodNumber++;
      const next = addMonthsClamped(cursor, 1);
      const lastDay = addCalendarDays(next, -1);
      const startsOn = cursor;
      const endsOn = lastDay < fiscalEnd ? lastDay : fiscalEnd;
      out.push({
        sourceRef: `${prefix}:${year.key}:${periodNumber}`,
        fields: {
          name: startsOn.slice(0, 7),
          fiscalYear: year.fiscalYear,
          periodNumber,
          startsOn,
          endsOn,
          isAdjustment: false,
          moduleStates: stateForEnd(endsOn),
          closedAt: endsOn,
        },
      });
      cursor = next;
    }
  }
  return out;
}

/** Build fiscal-year ranges covering a source's known operating date span. */
export function fiscalYearsForRange(start: string, end: string, startMonth: number): SourceFiscalYear[] {
  const first = parseIsoDate(start);
  parseIsoDate(end);
  const years: SourceFiscalYear[] = [];
  let startYear = first.getUTCFullYear();
  if (first.getUTCMonth() + 1 < startMonth) startYear--;
  for (;;) {
    const startsOn = civilDateFromParts(startYear, startMonth, 1);
    const endsOn = addCalendarDays(civilDateFromParts(startYear + 1, startMonth, 1), -1);
    if (startsOn > end) break;
    const fiscalYear = startMonth === 1 ? startYear : startYear + 1;
    years.push({ key: String(fiscalYear), fiscalYear, startsOn, endsOn });
    startYear++;
  }
  return years;
}

export function fiscalYearsForEndingRule(
  start: string,
  end: string,
  endMonth: number,
  endDay: number,
): SourceFiscalYear[] {
  const rangeStartYear = parseIsoDate(start).getUTCFullYear();
  const rangeEndYear = parseIsoDate(end).getUTCFullYear();
  const years: SourceFiscalYear[] = [];
  const endFor = (year: number) => civilDateFromParts(year, endMonth, Math.min(endDay, daysInCivilMonth(year, endMonth)));
  for (let fiscalYear = rangeStartYear - 1; fiscalYear <= rangeEndYear + 2; fiscalYear++) {
    const endsOn = endFor(fiscalYear);
    const startsOn = addCalendarDays(endFor(fiscalYear - 1), 1);
    if (endsOn < start || startsOn > end) continue;
    years.push({ key: String(fiscalYear), fiscalYear, startsOn, endsOn });
  }
  return years;
}

export function allModules(state: ImportedLockState): ImportedModuleStates {
  return { ar: state, ap: state, banking: state, assets: state, tax: state, gl: state };
}
