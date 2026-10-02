import { civilDayIndex, daysInCivilMonth } from "../../platform/civil-date.ts";
import { BenefitsError } from "./errors.ts";

const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(date: string, label: string): number {
  const match = CIVIL_DATE_RE.exec(date);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(date)} is not a civil date — use YYYY-MM-DD`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysIn = daysInCivilMonth(year, month);
  if (day < 1 || day > daysIn) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(date)} is not a calendar day — ${year}-${String(month).padStart(2, "0")} has ${daysIn} days`,
    );
  }
  return civilDayIndex(date);
}

/** Inclusive covered days of the overlap between two date ranges. */
export function overlapDays(aFrom: string, aTo: string, bFrom: string, bTo: string): number {
  const start = Math.max(parseDay(aFrom, "range start"), parseDay(bFrom, "range start"));
  const end = Math.min(parseDay(aTo, "range end"), parseDay(bTo, "range end"));
  return end >= start ? end - start + 1 : 0;
}

export interface WindowShape {
  readonly kind: string;
  readonly opensOn: string;
  readonly closesOn: string;
  readonly employerSubsidiaryId: string | null;
  readonly departmentId: string | null;
}

/** Whether two windows of the same kind and scope overlap in time. */
export function windowsOverlap(a: WindowShape, b: WindowShape): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.employerSubsidiaryId ?? null) !== (b.employerSubsidiaryId ?? null)) return false;
  if ((a.departmentId ?? null) !== (b.departmentId ?? null)) return false;
  return overlapDays(a.opensOn, a.closesOn, b.opensOn, b.closesOn) > 0;
}

