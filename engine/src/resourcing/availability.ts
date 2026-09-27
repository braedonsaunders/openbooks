import { add, cmp, div, neg, sum } from "../money/money.ts";
import type { ObservedHoliday } from "../payroll/holidays.ts";
import {
  pickWorkSchedule,
  scheduledHoursBetween,
  type WorkScheduleRow,
  type WorkScheduleScope,
  type WorkScheduleScopeKeys,
} from "../payroll/work-schedules.ts";
import { ResourcingRefusal } from "./errors.ts";
import { weekDates } from "./weeks.ts";

export interface AvailabilityAbsence {
  id: string;
  onDate: string;
  hours: string;
}

export interface AvailabilityHolidayCalendar {
  applied: boolean;
  jurisdiction: string | null;
  reason?: string;
  dates: readonly ObservedHoliday[];
}

export interface ScheduleSourceEvidence {
  date: string;
  scheduleId: string;
  scope: WorkScheduleScope;
}

export type AvailabilityCapacityTier =
  | { tier: "schedule"; scheduleId: string; scope: WorkScheduleScope }
  | { tier: "labor-costing-standard"; annualHours: number }
  | { tier: "mixed"; annualHours: number | null }
  | { tier: "unknown"; cause: "varies-schedule" };

export interface AvailabilityFigure {
  employeePartyId: string;
  weekStart: string;
  capacity: {
    hours: string | null;
    tier: AvailabilityCapacityTier;
    scheduleSources: readonly ScheduleSourceEvidence[];
  };
  holidays: {
    applied: boolean;
    jurisdiction: string | null;
    reason?: string;
    dates: readonly { date: string; key: string; name: string }[];
    hours: string | null;
  };
  timeOff: {
    hours: string;
    absenceRowIds: readonly string[];
  };
  netCapacity: string | null;
  overage: boolean | null;
}

export interface ComputeAvailabilityInput {
  employeePartyId: string;
  weekStart: string;
  scheduleScope: Omit<WorkScheduleScopeKeys, "employeePartyId">;
  schedules: readonly WorkScheduleRow[];
  annualHours: number;
  holidays: AvailabilityHolidayCalendar;
  absences: readonly AvailabilityAbsence[];
}

/**
 * Compute one person's weekly capacity from the existing schedule, holiday,
 * and leave sources. The labor-costing standard is the organization's own
 * declared cost basis, spread across Monday through Friday when no schedule
 * applies; it is not an assumed work week.
 */
export function computeAvailabilityForWeek(input: ComputeAvailabilityInput): AvailabilityFigure {
  const dates = weekDates(input.weekStart);
  const annualHoursText = String(input.annualHours);
  const standardWeekHours = div(annualHoursText, "52");
  const standardDayHours = div(standardWeekHours, "5");
  const scheduleSources: ScheduleSourceEvidence[] = [];
  const hoursByDate = new Map<string, string | null>();
  let usedStandard = false;
  let unknownSchedule = false;

  for (const [dayIndex, date] of dates.entries()) {
    const schedule = pickWorkSchedule(
      input.schedules,
      { employeePartyId: input.employeePartyId, ...input.scheduleScope },
      date,
    );
    if (schedule) {
      scheduleSources.push({ date, scheduleId: schedule.id, scope: schedule.scope });
      const hours = scheduledHoursBetween(schedule, date, date);
      if (hours === null) {
        unknownSchedule = true;
        hoursByDate.set(date, null);
      } else {
        hoursByDate.set(date, hours);
      }
      continue;
    }

    usedStandard = true;
    hoursByDate.set(date, dayIndex >= 1 && dayIndex <= 5 ? standardDayHours : "0.0000");
  }

  const distinctSchedules = new Map<string, WorkScheduleScope>();
  for (const source of scheduleSources) distinctSchedules.set(source.scheduleId, source.scope);
  const capacityTier: AvailabilityCapacityTier = unknownSchedule
    ? { tier: "unknown", cause: "varies-schedule" }
    : distinctSchedules.size === 0
      ? { tier: "labor-costing-standard", annualHours: input.annualHours }
      : distinctSchedules.size === 1 && !usedStandard
        ? {
          tier: "schedule",
          scheduleId: distinctSchedules.keys().next().value!,
          scope: distinctSchedules.values().next().value!,
        }
        : { tier: "mixed", annualHours: usedStandard ? input.annualHours : null };

  const capacityHours = unknownSchedule
    ? null
    : distinctSchedules.size === 0
      ? standardWeekHours
      : sum(dates.map((date) => hoursByDate.get(date) ?? "0.0000"));

  const holidaysByDate = new Map<string, ObservedHoliday>();
  const weekHolidayEvidence: ObservedHoliday[] = [];
  if (input.holidays.applied) {
    for (const holiday of input.holidays.dates) {
      if (holiday.date >= dates[0]! && holiday.date <= dates[6]!) {
        weekHolidayEvidence.push(holiday);
        holidaysByDate.set(holiday.date, holiday);
      }
    }
  }
  const holidayHours = [...holidaysByDate.keys()].reduce<string | null>((total, date) => {
    const scheduled = hoursByDate.get(date);
    if (total === null || scheduled === null || scheduled === undefined) return null;
    return add(total, scheduled);
  }, "0.0000");

  const weekAbsences = input.absences.filter(
    (absence) => absence.onDate >= dates[0]! && absence.onDate <= dates[6]!,
  );
  const absenceHours = sum(weekAbsences.map((absence) => absence.hours));
  const netBeforeFloor = capacityHours === null || holidayHours === null
    ? null
    : sum([capacityHours, neg(holidayHours), neg(absenceHours)]);
  const overage = netBeforeFloor === null ? null : cmp(netBeforeFloor, "0") < 0;

  return {
    employeePartyId: input.employeePartyId,
    weekStart: input.weekStart,
    capacity: {
      hours: capacityHours,
      tier: capacityTier,
      scheduleSources,
    },
    holidays: {
      applied: input.holidays.applied,
      jurisdiction: input.holidays.jurisdiction,
      ...(input.holidays.reason === undefined ? {} : { reason: input.holidays.reason }),
      dates: weekHolidayEvidence.map(({ date, key, name }) => ({ date, key, name })),
      hours: holidayHours,
    },
    timeOff: {
      hours: absenceHours,
      absenceRowIds: weekAbsences.map((absence) => absence.id),
    },
    netCapacity: netBeforeFloor === null || cmp(netBeforeFloor, "0") < 0
      ? (netBeforeFloor === null ? null : "0.0000")
      : netBeforeFloor,
    overage,
  };
}

/** Refuse an assignment when a person's declared varying schedule has no weekly capacity. */
export function assertPlannableCapacity(figure: AvailabilityFigure): void {
  if (figure.capacity.tier.tier !== "unknown") return;
  throw new ResourcingRefusal(
    422,
    "capacity_unknown",
    `capacity for ${figure.employeePartyId} is unknown because the work schedule declares that hours vary`,
    "give this person a cycle schedule in Setup → Payroll → Work schedules",
    "employeePartyId",
  );
}
