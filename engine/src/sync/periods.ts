import type { SourceEntity } from "./source.ts";

export type ImportedLockState = "open" | "soft_closed" | "closed";
export type ImportedModuleStates = Partial<Record<"ar" | "ap" | "banking" | "assets" | "tax" | "gl", ImportedLockState>>;

export interface SourceFiscalYear {
  key: string;
  fiscalYear: number;
  startsOn: string;
  endsOn: string;
}

const iso = (date: Date) => date.toISOString().slice(0, 10);
const utc = (value: string) => new Date(`${value}T00:00:00Z`);
const addMonths = (date: Date, months: number) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
const dayBefore = (date: Date) => new Date(date.getTime() - 86_400_000);

/** Build exact monthly posting periods inside source fiscal-year boundaries. */
export function monthlySourcePeriods(
  prefix: string,
  years: SourceFiscalYear[],
  stateForEnd: (endsOn: string) => ImportedModuleStates,
): SourceEntity[] {
  const out: SourceEntity[] = [];
  for (const year of years) {
    let cursor = utc(year.startsOn);
    const fiscalEnd = utc(year.endsOn);
    let periodNumber = 0;
    while (cursor <= fiscalEnd) {
      periodNumber++;
      const next = addMonths(cursor, 1);
      const periodEnd = dayBefore(next) < fiscalEnd ? dayBefore(next) : fiscalEnd;
      const startsOn = iso(cursor);
      const endsOn = iso(periodEnd);
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
  const first = utc(start);
  const last = utc(end);
  const years: SourceFiscalYear[] = [];
  let startYear = first.getUTCFullYear();
  if (first.getUTCMonth() + 1 < startMonth) startYear--;
  for (;;) {
    const starts = new Date(Date.UTC(startYear, startMonth - 1, 1));
    const ends = dayBefore(new Date(Date.UTC(startYear + 1, startMonth - 1, 1)));
    if (starts > last) break;
    const fiscalYear = startMonth === 1 ? startYear : startYear + 1;
    years.push({ key: String(fiscalYear), fiscalYear, startsOn: iso(starts), endsOn: iso(ends) });
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
  const rangeStart = utc(start);
  const rangeEnd = utc(end);
  const years: SourceFiscalYear[] = [];
  const endFor = (year: number) => {
    const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    return new Date(Date.UTC(year, endMonth - 1, Math.min(endDay, lastDay)));
  };
  for (let fiscalYear = rangeStart.getUTCFullYear() - 1; fiscalYear <= rangeEnd.getUTCFullYear() + 2; fiscalYear++) {
    const ends = endFor(fiscalYear);
    const starts = new Date(endFor(fiscalYear - 1).getTime() + 86_400_000);
    if (ends < rangeStart || starts > rangeEnd) continue;
    years.push({ key: String(fiscalYear), fiscalYear, startsOn: iso(starts), endsOn: iso(ends) });
  }
  return years;
}

export function allModules(state: ImportedLockState): ImportedModuleStates {
  return { ar: state, ap: state, banking: state, assets: state, tax: state, gl: state };
}
