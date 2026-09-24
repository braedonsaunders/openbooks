import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../money/money.ts";
import {
  emptyPopulationGate,
  evaluateCrewGate,
  isEmptyCrewPopulation,
  isEmptyPopulation,
  type CrewTargetRow,
} from "./parity-gates.ts";

test("a missing artifact is not an empty one", () => {
  assert.equal(isEmptyPopulation(null), false);
  assert.equal(isEmptyPopulation([{ id: "1" }, { id: "2" }]), false);
  assert.equal(isEmptyPopulation([]), true);
  assert.equal(isEmptyCrewPopulation(null), false);
  assert.equal(isEmptyCrewPopulation(new Map([["a|b", 1n]])), false);
  assert.equal(isEmptyCrewPopulation(new Map()), true);
});

test("an empty source population earns unproven, never agreement", () => {
  // Two consumed artifacts side by side: the gate must name the file and
  // refuse agreement even when the tenant side is equally empty.
  for (const artifact of ["/tmp/parity-ns-projects.json", "/tmp/parity-ns-invoices.json"]) {
    const gate = emptyPopulationGate(0, artifact);
    assert.equal(gate.status, "unproven");
    assert.equal(gate.sourceCount, 0);
    assert.equal(gate.exactCount, null);
    assert.equal(gate.mismatchCount, null);
    assert.ok(gate.detail.includes(artifact));
    assert.match(gate.detail, /no data compared/);
  }
});

test("the empty gate keeps the tenant denominator for triage", () => {
  const gate = emptyPopulationGate(3, "/tmp/parity-ns-projects.json");
  assert.equal(gate.targetCount, 3);
});

function crewRow(ticket: string, hours: string): CrewTargetRow {
  return {
    source_id: ticket,
    source_employee_id: "E7",
    source_item_id: "REG",
    worked_on: "2024-06-10",
    time_kind: "regular",
    hours,
  };
}

test("a deleted ticket reads as a target-only difference, never agreement", () => {
  // Two source tickets exported; the tenant still carries hours for a third
  // ticket the export no longer lists. The old gate dropped rows outside the
  // current source ids before aggregating, so the deletion read as exact.
  const source = new Map([
    ["T1|E7|REG|2024-06-10|regular", toUnits("8")],
    ["T2|E7|REG|2024-06-10|regular", toUnits("6")],
  ]);
  const target = [crewRow("T1", "8"), crewRow("T2", "6"), crewRow("T9", "8")];
  const gate = evaluateCrewGate(source, target);
  assert.equal(gate.status, "different");
  assert.equal(gate.sourceCount, 2);
  assert.equal(gate.targetOnlyCount, 1);
  assert.equal(gate.exactCount, 2);
  assert.equal(gate.mismatchCount, 1);
  assert.equal(gate.differences.length, 1);
  assert.ok(gate.differences[0]!.sourceRef.startsWith("T9|"));
  assert.equal(gate.differences[0]!.source, "0.0000");
  assert.match(gate.detail, /1 target-only/);
  // The surviving tickets' keys are told apart from the deleted one.
  assert.ok(!gate.differences.some((difference) => difference.sourceRef.startsWith("T1|")));
});

test("a fully retained crew population still reads exact", () => {
  const source = new Map([
    ["T1|E7|REG|2024-06-10|regular", toUnits("8")],
    ["T2|E7|REG|2024-06-10|regular", toUnits("6")],
  ]);
  const gate = evaluateCrewGate(source, [crewRow("T1", "8"), crewRow("T2", "6")]);
  assert.equal(gate.status, "exact");
  assert.equal(gate.targetOnlyCount, 0);
  assert.equal(gate.mismatchCount, 0);
  assert.deepEqual(gate.differences, []);
});
