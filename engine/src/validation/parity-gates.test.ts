import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyPopulationGate,
  isEmptyCrewPopulation,
  isEmptyPopulation,
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
