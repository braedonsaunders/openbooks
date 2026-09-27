import type { PersonWeekForecast } from "@openbooks/engine/src/resourcing/forecast.ts";
import { add } from "@openbooks/engine/src/money/money.ts";
import { formatTicketHours } from "../format.ts";

export const NO_CAPACITY_REMEDY =
  "give this person a cycle schedule (Setup → Payroll → Work schedules)";

export type BoardChip = {
  key: "hard" | "soft" | "available" | "capacity";
  hours?: string;
  variant: "secondary" | "success" | "destructive" | "outline";
  remedy?: string;
};

/** Build exact, display-ready hour chips from one person-week forecast. */
export function boardCell(personWeek: PersonWeekForecast | null | undefined): BoardChip[] {
  const hardHours = personWeek
    ? add(personWeek.hardBillableHours, personWeek.hardNonBillableHours)
    : "0.0000";
  const softHours = personWeek
    ? add(personWeek.softBillableHours, personWeek.softNonBillableHours)
    : "0.0000";
  const chips: BoardChip[] = [
    { key: "hard", hours: formatTicketHours(hardHours), variant: "secondary" },
    { key: "soft", hours: formatTicketHours(softHours), variant: "outline" },
  ];
  if (!personWeek || personWeek.availableHours === null) {
    chips.push({ key: "capacity", variant: "outline", remedy: NO_CAPACITY_REMEDY });
    return chips;
  }
  chips.push({
    key: "available",
    hours: formatTicketHours(personWeek.availableHours),
    variant: personWeek.overallocated ? "destructive" : "success",
  });
  return chips;
}

export type CellPosition = { row: number; column: number };
export type CellBounds = { rows: number; columns: number };
export type CellArrow = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** Move a focused person-week cell by one step, clamping at the board edge. */
export function nextCell(
  position: CellPosition,
  key: CellArrow,
  bounds: CellBounds,
): CellPosition {
  if (bounds.rows < 1 || bounds.columns < 1) return { row: 0, column: 0 };
  const delta = key === "ArrowUp" ? [-1, 0]
    : key === "ArrowDown" ? [1, 0]
      : key === "ArrowLeft" ? [0, -1]
        : [0, 1];
  return {
    row: Math.max(0, Math.min(bounds.rows - 1, position.row + delta[0]!)),
    column: Math.max(0, Math.min(bounds.columns - 1, position.column + delta[1]!)),
  };
}
