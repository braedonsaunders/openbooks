import assert from "node:assert/strict";
import test from "node:test";
import type { PersonWeekForecast } from "@openbooks/engine/src/resourcing/forecast.ts";
import { boardCell, nextCell, NO_CAPACITY_REMEDY } from "./board-cells.ts";

function forecast(overrides: Partial<PersonWeekForecast> = {}): PersonWeekForecast {
  return {
    employeePartyId: "person",
    weekStart: "2026-10-04",
    capacity: null,
    holidays: null,
    timeOff: null,
    netCapacity: null,
    capacityOverage: null,
    hardBillableHours: "8.2500",
    hardNonBillableHours: "0.2500",
    softBillableHours: "1.5000",
    softNonBillableHours: "0.0000",
    availableHours: "31.5000",
    overallocated: false,
    assignmentIds: [],
    hardBillableAssignmentIds: [],
    hardNonBillableAssignmentIds: [],
    softBillableAssignmentIds: [],
    softNonBillableAssignmentIds: [],
    ...overrides,
  };
}

test("board chips preserve exact totals, flag overage, and name unknown capacity", () => {
  assert.deepEqual(boardCell(forecast()), [
    { key: "hard", hours: "8.5", variant: "secondary" },
    { key: "soft", hours: "1.5", variant: "outline" },
    { key: "available", hours: "31.5", variant: "success" },
  ]);
  const over = boardCell(forecast({ availableHours: "-2.0000", overallocated: true }));
  assert.equal(over[2]?.variant, "destructive");
  const unknown = boardCell(forecast({ availableHours: null, overallocated: null }));
  assert.deepEqual(unknown[2], { key: "capacity", variant: "outline", remedy: NO_CAPACITY_REMEDY });
});

test("nextCell moves in four directions and clamps at each edge", () => {
  const bounds = { rows: 3, columns: 4 };
  assert.deepEqual(nextCell({ row: 1, column: 1 }, "ArrowUp", bounds), { row: 0, column: 1 });
  assert.deepEqual(nextCell({ row: 1, column: 1 }, "ArrowDown", bounds), { row: 2, column: 1 });
  assert.deepEqual(nextCell({ row: 1, column: 1 }, "ArrowLeft", bounds), { row: 1, column: 0 });
  assert.deepEqual(nextCell({ row: 1, column: 1 }, "ArrowRight", bounds), { row: 1, column: 2 });
  assert.deepEqual(nextCell({ row: 0, column: 0 }, "ArrowUp", bounds), { row: 0, column: 0 });
  assert.deepEqual(nextCell({ row: 2, column: 3 }, "ArrowRight", bounds), { row: 2, column: 3 });
});
