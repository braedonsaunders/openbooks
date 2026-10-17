/**
 * Vesting schedules, measured in the units a security was issued in.
 *
 * Three shapes, as the schema stores them:
 *  - No schedule: fully vested on the issue date.
 *  - Dated tranches: each tranche vests on its date; the tranches sum to the
 *    issued quantity.
 *  - Time-based: nothing before the cliff, then whole-share straight-line
 *    steps (monthly, quarterly or annual) to the full quantity at the final
 *    month. A cliff between steps vests its whole catch-up on the cliff date.
 *
 * Months are counted as completed calendar months from the vesting start
 * (a month completes on the same day of month, clamped to the month's last
 * day), so every installment date is `start + n months` and reads back as
 * exactly n completed months.
 */
import { addMonthsClamped, isIsoCalendarDate } from "../platform/civil-date.ts";
import { EquityError } from "./errors.ts";
import { floorShares, multiplyRational, parsePercent, rational } from "./quantities.ts";
import type { Acceleration, VestingFrequency, VestingTranche } from "./types.ts";

export const VESTING_STEP_MONTHS: Readonly<Record<VestingFrequency, number>> = { monthly: 1, quarterly: 3, annual: 12 };

export interface VestingTerms {
  issueDate: string;
  /** Quantity the schedule is written for, in issue units. */
  quantity: bigint;
  vestingStart: string | null;
  vestingMonths: number | null;
  cliffMonths: number | null;
  vestingFrequency: VestingFrequency | null;
  vestingTranches: readonly VestingTranche[] | null;
}

export interface VestingInstallment {
  date: string;
  quantity: bigint;
  /** Vested in total once this installment lands. */
  cumulative: bigint;
}

function day(iso: string): number {
  return Number(iso.slice(8, 10));
}

function daysInMonth(year: number, month1: number): number {
  if (month1 === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month1) ? 30 : 31;
}

/**
 * Completed calendar months from `from` to `to` (zero when `to` precedes
 * `from`). A month completes on the same day of month, or on the last day
 * of a shorter month.
 */
export function completedMonths(from: string, to: string): number {
  if (to <= from) return 0;
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  let months = (ty - fy) * 12 + (tm - fm);
  if (day(to) < Math.min(day(from), daysInMonth(ty, tm))) months -= 1;
  return Math.max(0, months);
}

export function hasVestingSchedule(terms: Pick<VestingTerms, "vestingMonths" | "vestingTranches">): boolean {
  return (terms.vestingMonths ?? 0) > 0 || (terms.vestingTranches?.length ?? 0) > 0;
}

/** Vested at a count of completed months on a time-based schedule. */
function timeBasedVested(quantity: bigint, months: number, cliff: number, total: number, step: number): bigint {
  if (months < cliff) return 0n;
  if (months >= total) return quantity;
  const stepped = Math.max(cliff, Math.floor(months / step) * step);
  return floorShares(rational(quantity * BigInt(stepped), BigInt(total)));
}

/**
 * Refuse a schedule the math cannot honour: tranches that are undated,
 * duplicated, out of order or that do not sum to the quantity; a
 * time-based schedule without its start, frequency or a cliff inside it.
 */
export function validateVestingTerms(terms: VestingTerms): void {
  const refuse = (message: string, remedy: string): never => {
    throw new EquityError(message, { code: "equity_vesting_invalid", remedy, field: "vesting" });
  };
  if (terms.vestingTranches && terms.vestingTranches.length > 0) {
    if (terms.vestingMonths !== null || terms.cliffMonths !== null || terms.vestingFrequency !== null) {
      refuse("A schedule is either dated tranches or a time-based schedule, not both.", "Remove the time-based terms or the tranches.");
    }
    let previous = "";
    let total = 0n;
    for (const tranche of terms.vestingTranches) {
      if (!isIsoCalendarDate(tranche.date)) refuse("Every tranche needs a valid YYYY-MM-DD date.", "Correct the tranche dates.");
      if (tranche.date <= previous) refuse("Tranche dates must be distinct and in ascending order.", "List each tranche once, earliest first.");
      if (tranche.quantity <= 0n) refuse("Every tranche must vest at least one share.", "Remove empty tranches.");
      previous = tranche.date;
      total += tranche.quantity;
    }
    if (total !== terms.quantity) {
      refuse(`The tranches vest ${total} shares but the security carries ${terms.quantity}.`, "Make the tranche quantities sum to the security's quantity.");
    }
    return;
  }
  if (terms.vestingMonths === null) {
    if (terms.cliffMonths !== null || terms.vestingFrequency !== null) {
      refuse("A cliff or frequency needs a vesting term in months.", "Enter the vesting term, or clear the cliff and frequency.");
    }
    return;
  }
  if (!Number.isInteger(terms.vestingMonths) || terms.vestingMonths < 1 || terms.vestingMonths > 600) {
    refuse("The vesting term must be a whole number of months from 1 to 600.", "Enter the vesting term in whole months.");
  }
  const cliff = terms.cliffMonths ?? 0;
  if (!Number.isInteger(cliff) || cliff < 0 || cliff > (terms.vestingMonths ?? 0)) {
    refuse("The cliff must be a whole number of months within the vesting term.", "Enter a cliff from 0 to the vesting term.");
  }
  if (!terms.vestingFrequency || !(terms.vestingFrequency in VESTING_STEP_MONTHS)) {
    refuse("A time-based schedule needs a vesting frequency.", "Choose monthly, quarterly or annual vesting.");
  }
  if (!terms.vestingStart || !isIsoCalendarDate(terms.vestingStart)) {
    refuse("A time-based schedule needs a vesting start date.", "Enter the vesting start date as YYYY-MM-DD.");
  }
}

/** Every date on which the vested quantity rises, with the units landing then. */
export function vestingInstallments(terms: VestingTerms): VestingInstallment[] {
  if (terms.vestingTranches && terms.vestingTranches.length > 0) {
    let cumulative = 0n;
    return terms.vestingTranches.map((tranche) => {
      cumulative += tranche.quantity;
      return { date: tranche.date, quantity: tranche.quantity, cumulative };
    });
  }
  const total = terms.vestingMonths ?? 0;
  if (total <= 0) return terms.quantity > 0n ? [{ date: terms.issueDate, quantity: terms.quantity, cumulative: terms.quantity }] : [];
  const start = terms.vestingStart ?? terms.issueDate;
  const cliff = terms.cliffMonths ?? 0;
  const step = VESTING_STEP_MONTHS[terms.vestingFrequency ?? "monthly"];
  const out: VestingInstallment[] = [];
  let previous = 0n;
  for (let month = 1; month <= total; month += 1) {
    const vested = timeBasedVested(terms.quantity, month, cliff, total, step);
    if (vested > previous) {
      out.push({ date: addMonthsClamped(start, month), quantity: vested - previous, cumulative: vested });
      previous = vested;
    }
  }
  return out;
}

/** Units the schedule has vested by `asOf` (inclusive), before any forfeiture. */
export function scheduledVested(terms: VestingTerms, asOf: string): bigint {
  if (asOf < terms.issueDate) return 0n;
  if (terms.vestingTranches && terms.vestingTranches.length > 0) {
    let vested = 0n;
    for (const tranche of terms.vestingTranches) if (tranche.date <= asOf) vested += tranche.quantity;
    return vested < terms.quantity ? vested : terms.quantity;
  }
  const total = terms.vestingMonths ?? 0;
  if (total <= 0) return terms.quantity;
  const start = terms.vestingStart ?? terms.issueDate;
  const step = VESTING_STEP_MONTHS[terms.vestingFrequency ?? "monthly"];
  return timeBasedVested(terms.quantity, completedMonths(start, asOf), terms.cliffMonths ?? 0, total, step);
}

/** The date the schedule completes (the issue date when nothing vests later). */
export function finalVestingDate(terms: VestingTerms): string {
  const installments = vestingInstallments(terms);
  return installments.length > 0 ? installments[installments.length - 1]!.date : terms.issueDate;
}

export interface AccelerationTrigger {
  changeOfControl: boolean;
  /** The holder's service also ends (the second trigger of a double-trigger clause). */
  terminated: boolean;
}

/**
 * Units vested once a recorded acceleration clause fires: the stated
 * percentage of the unvested remainder vests on top, in whole shares
 * (rounded down). Single trigger needs a change of control; double trigger
 * also needs the holder's termination. A clause that does not fire changes
 * nothing.
 */
export function acceleratedVested(
  vested: bigint,
  outstanding: bigint,
  terms: { acceleration: Acceleration; accelerationPercent: string | null },
  trigger: AccelerationTrigger,
): bigint {
  const fires = (terms.acceleration === "single" && trigger.changeOfControl)
    || (terms.acceleration === "double" && trigger.changeOfControl && trigger.terminated);
  const capped = vested < outstanding ? vested : outstanding;
  if (!fires) return capped;
  const percent = parsePercent(terms.accelerationPercent ?? "", "the acceleration percentage");
  const extra = floorShares(multiplyRational(rational(outstanding - capped), percent));
  const total = capped + extra;
  return total < outstanding ? total : outstanding;
}

/**
 * Read stored tranches (`[{ "date": "YYYY-MM-DD", "quantity": "<whole>" }]`).
 * Anything else refuses by name; a malformed schedule never vests silently.
 */
export function parseVestingTranches(raw: unknown): VestingTranche[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new EquityError("The stored vesting tranches are not a list.", {
      code: "equity_vesting_invalid",
      remedy: "Record the tranches as a list of dated whole-share quantities.",
    });
  }
  return raw.map((entry) => {
    const date = entry && typeof entry === "object" ? (entry as { date?: unknown }).date : undefined;
    const quantity = entry && typeof entry === "object" ? (entry as { quantity?: unknown }).quantity : undefined;
    const text = typeof quantity === "string" ? quantity : typeof quantity === "number" && Number.isSafeInteger(quantity) ? String(quantity) : "";
    if (typeof date !== "string" || !isIsoCalendarDate(date) || !/^\d+$/.test(text)) {
      throw new EquityError("A vesting tranche needs a YYYY-MM-DD date and a whole-share quantity.", {
        code: "equity_vesting_invalid",
        remedy: "Correct the tranche dates and quantities.",
      });
    }
    return { date, quantity: BigInt(text) };
  });
}
