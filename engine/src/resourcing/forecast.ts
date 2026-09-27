import { add, cmp, neg, sum } from "../money/money.ts";
import { addCalendarDays, calendarDaysBetween } from "../platform/business-date.ts";
import { resAssignments } from "@openbooks/schema";
import type { AvailabilityFigure } from "./availability.ts";
import { weekStartOf } from "./weeks.ts";

type AssignmentRow = typeof resAssignments.$inferSelect;

export interface ForecastWindow {
  firstWeek: string;
  lastWeek: string;
  asOf: string;
  rolloffWeeks: number;
}

export interface PersonWeekForecast {
  employeePartyId: string;
  weekStart: string;
  capacity: AvailabilityFigure["capacity"] | null;
  holidays: AvailabilityFigure["holidays"] | null;
  timeOff: AvailabilityFigure["timeOff"] | null;
  netCapacity: string | null;
  capacityOverage: boolean | null;
  hardBillableHours: string;
  hardNonBillableHours: string;
  softBillableHours: string;
  softNonBillableHours: string;
  availableHours: string | null;
  overallocated: boolean | null;
  assignmentIds: string[];
  hardBillableAssignmentIds: string[];
  hardNonBillableAssignmentIds: string[];
  softBillableAssignmentIds: string[];
  softNonBillableAssignmentIds: string[];
}

export interface BenchPerson {
  employeePartyId: string;
  weekStarts: string[];
  netCapacity: string;
  assignmentIds: string[];
}

export interface RolloffPerson {
  employeePartyId: string;
  lastHardWeek: string;
  assignmentIds: string[];
  tentativeAfterIds: string[];
}

export interface GenericDemandWeek {
  jobTitle: string;
  weekStart: string;
  hardHours: string;
  softHours: string;
  totalHours: string;
  assignmentIds: string[];
  hardAssignmentIds: string[];
  softAssignmentIds: string[];
}

export interface ResourcingForecast {
  personWeeks: PersonWeekForecast[];
  bench: BenchPerson[];
  rolloffs: RolloffPerson[];
  genericDemand: GenericDemandWeek[];
}

interface MutablePersonWeek {
  employeePartyId: string;
  weekStart: string;
  availability: AvailabilityFigure | null;
  hardBillable: string[];
  hardNonBillable: string[];
  softBillable: string[];
  softNonBillable: string[];
}

interface MutableGenericWeek {
  jobTitle: string;
  weekStart: string;
  hard: string[];
  soft: string[];
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compareText);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertWeekRange(window: ForecastWindow): void {
  for (const [field, date] of [["firstWeek", window.firstWeek], ["lastWeek", window.lastWeek]] as const) {
    if (weekStartOf(date) !== date) throw new RangeError(`${field} must be a Sunday`);
  }
  const spanDays = calendarDaysBetween(window.firstWeek, window.lastWeek);
  if (spanDays < 0 || spanDays % 7 !== 0) {
    throw new RangeError("lastWeek must be a Sunday on or after firstWeek");
  }
  if (!Number.isSafeInteger(window.rolloffWeeks) || window.rolloffWeeks < 0) {
    throw new RangeError("rolloffWeeks must be a non-negative integer");
  }
  weekStartOf(window.asOf);
}

function inWindow(weekStart: string, window: ForecastWindow): boolean {
  return weekStart >= window.firstWeek && weekStart <= window.lastWeek;
}

/** Build additive person-week facts and their assignment evidence without database access. */
export function buildResourcingForecast(
  assignments: readonly AssignmentRow[],
  availability: readonly AvailabilityFigure[],
  window: ForecastWindow,
): ResourcingForecast {
  assertWeekRange(window);
  const availabilityByKey = new Map<string, AvailabilityFigure>();
  for (const figure of availability) {
    const key = `${figure.employeePartyId}\u0000${figure.weekStart}`;
    if (availabilityByKey.has(key)) throw new Error(`duplicate availability figure for ${key}`);
    availabilityByKey.set(key, figure);
  }

  const personWeeks = new Map<string, MutablePersonWeek>();
  const genericWeeks = new Map<string, MutableGenericWeek>();
  const activeAssignments: AssignmentRow[] = [];
  const activeById = new Map<string, AssignmentRow>();
  const personHardWeeks = new Map<string, Map<string, string[]>>();
  const personSoftWeeks = new Map<string, Map<string, string[]>>();

  const getPersonWeek = (employeePartyId: string, weekStart: string): MutablePersonWeek => {
    const key = `${employeePartyId}\u0000${weekStart}`;
    let fact = personWeeks.get(key);
    if (!fact) {
      fact = {
        employeePartyId,
        weekStart,
        availability: availabilityByKey.get(key) ?? null,
        hardBillable: [],
        hardNonBillable: [],
        softBillable: [],
        softNonBillable: [],
      };
      personWeeks.set(key, fact);
    }
    return fact;
  };

  for (const figure of availability) getPersonWeek(figure.employeePartyId, figure.weekStart);
  for (const row of assignments) {
    if (row.state === "released") continue;
    activeAssignments.push(row);
    activeById.set(row.id, row);
    if (row.employeePartyId) {
      const fact = getPersonWeek(row.employeePartyId, row.weekStart);
      const bucket = row.booking === "hard"
        ? (row.isBillable ? fact.hardBillable : fact.hardNonBillable)
        : (row.isBillable ? fact.softBillable : fact.softNonBillable);
      bucket.push(row.id);
      const weekMap = row.booking === "hard" ? personHardWeeks : personSoftWeeks;
      const weeks = weekMap.get(row.employeePartyId) ?? new Map<string, string[]>();
      const ids = weeks.get(row.weekStart) ?? [];
      ids.push(row.id);
      weeks.set(row.weekStart, ids);
      weekMap.set(row.employeePartyId, weeks);
    } else if (row.jobTitle) {
      const titleKey = row.jobTitle.trim().toLowerCase();
      const key = `${titleKey}\u0000${row.weekStart}`;
      let fact = genericWeeks.get(key);
      if (!fact) {
        fact = { jobTitle: row.jobTitle.trim(), weekStart: row.weekStart, hard: [], soft: [] };
        genericWeeks.set(key, fact);
      } else if (row.jobTitle.trim() < fact.jobTitle) {
        fact.jobTitle = row.jobTitle.trim();
      }
      (row.booking === "hard" ? fact.hard : fact.soft).push(row.id);
    }
  }

  const facts = [...personWeeks.values()].map((fact): PersonWeekForecast => {
    const hardBillableHours = sum(fact.hardBillable.map((id) => {
      return activeById.get(id)!.plannedHours;
    }));
    const hardNonBillableHours = sum(fact.hardNonBillable.map((id) => {
      return activeById.get(id)!.plannedHours;
    }));
    const softBillableHours = sum(fact.softBillable.map((id) => {
      return activeById.get(id)!.plannedHours;
    }));
    const softNonBillableHours = sum(fact.softNonBillable.map((id) => {
      return activeById.get(id)!.plannedHours;
    }));
    const hardHours = add(hardBillableHours, hardNonBillableHours);
    const netCapacity = fact.availability?.netCapacity ?? null;
    return {
      employeePartyId: fact.employeePartyId,
      weekStart: fact.weekStart,
      capacity: fact.availability?.capacity ?? null,
      holidays: fact.availability?.holidays ?? null,
      timeOff: fact.availability?.timeOff ?? null,
      netCapacity,
      capacityOverage: fact.availability?.overage ?? null,
      hardBillableHours,
      hardNonBillableHours,
      softBillableHours,
      softNonBillableHours,
      availableHours: netCapacity === null ? null : add(netCapacity, neg(hardHours)),
      overallocated: netCapacity === null ? null : cmp(hardHours, netCapacity) > 0,
      assignmentIds: sorted([
        ...fact.hardBillable,
        ...fact.hardNonBillable,
        ...fact.softBillable,
        ...fact.softNonBillable,
      ]),
      hardBillableAssignmentIds: sorted(fact.hardBillable),
      hardNonBillableAssignmentIds: sorted(fact.hardNonBillable),
      softBillableAssignmentIds: sorted(fact.softBillable),
      softNonBillableAssignmentIds: sorted(fact.softNonBillable),
    };
  }).sort((a, b) => compareText(a.weekStart, b.weekStart) || compareText(a.employeePartyId, b.employeePartyId));

  const hardIdsByPerson = new Map<string, string[]>();
  for (const [personId, weeks] of personHardWeeks) {
    hardIdsByPerson.set(personId, [...weeks.values()].flat());
  }
  const benchByPerson = new Map<string, BenchPerson>();
  for (const fact of facts) {
    if (!inWindow(fact.weekStart, window) || fact.netCapacity === null || cmp(fact.netCapacity, "0") <= 0) continue;
    const existing = benchByPerson.get(fact.employeePartyId) ?? {
      employeePartyId: fact.employeePartyId,
      weekStarts: [],
      netCapacity: "0.0000",
      assignmentIds: [],
    };
    existing.weekStarts.push(fact.weekStart);
    existing.netCapacity = add(existing.netCapacity, fact.netCapacity);
    existing.assignmentIds.push(...fact.assignmentIds);
    benchByPerson.set(fact.employeePartyId, existing);
  }
  const bench = [...benchByPerson.values()]
    .filter((person) => (hardIdsByPerson.get(person.employeePartyId) ?? []).every((id) => {
      const row = activeById.get(id)!;
      return !inWindow(row.weekStart, window);
    }))
    .map((person) => ({
      ...person,
      weekStarts: sorted(person.weekStarts),
      assignmentIds: sorted(person.assignmentIds),
    }))
    .sort((a, b) => compareText(a.employeePartyId, b.employeePartyId));

  const asOfWeek = weekStartOf(window.asOf);
  const rolloffEnd = addCalendarDays(asOfWeek, window.rolloffWeeks * 7);
  const hardWeeksByPerson = new Map<string, string[]>();
  for (const row of activeAssignments) {
    if (!row.employeePartyId || row.booking !== "hard") continue;
    const weeks = hardWeeksByPerson.get(row.employeePartyId) ?? [];
    weeks.push(row.weekStart);
    hardWeeksByPerson.set(row.employeePartyId, weeks);
  }
  const rolloffs: RolloffPerson[] = [];
  for (const [employeePartyId, hardWeeks] of hardWeeksByPerson) {
    const lastHardWeek = hardWeeks.reduce((latest, week) => week > latest ? week : latest);
    if (lastHardWeek < asOfWeek || lastHardWeek > rolloffEnd) continue;
    const lastWeekIds = personHardWeeks.get(employeePartyId)?.get(lastHardWeek) ?? [];
    const tentativeAfterIds = activeAssignments
      .filter((row) => row.employeePartyId === employeePartyId && row.booking === "soft" && row.weekStart > lastHardWeek)
      .map((row) => row.id);
    rolloffs.push({
      employeePartyId,
      lastHardWeek,
      assignmentIds: sorted(hardIdsByPerson.get(employeePartyId) ?? lastWeekIds),
      tentativeAfterIds: sorted(tentativeAfterIds),
    });
  }
  rolloffs.sort((a, b) => compareText(a.lastHardWeek, b.lastHardWeek) || compareText(a.employeePartyId, b.employeePartyId));

  const genericDemand = [...genericWeeks.values()].map((fact): GenericDemandWeek => {
    const hardHours = sum(fact.hard.map((id) => activeById.get(id)!.plannedHours));
    const softHours = sum(fact.soft.map((id) => activeById.get(id)!.plannedHours));
    return {
      jobTitle: fact.jobTitle,
      weekStart: fact.weekStart,
      hardHours,
      softHours,
      totalHours: add(hardHours, softHours),
      assignmentIds: sorted([...fact.hard, ...fact.soft]),
      hardAssignmentIds: sorted(fact.hard),
      softAssignmentIds: sorted(fact.soft),
    };
  }).sort((a, b) => compareText(a.weekStart, b.weekStart) || compareText(a.jobTitle, b.jobTitle));

  return { personWeeks: facts, bench, rolloffs, genericDemand };
}
