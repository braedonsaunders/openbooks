import assert from "node:assert/strict";
import test from "node:test";
import { renderTemplate, selectDueStage, type DunningStage } from "./dunning.ts";

const stage = (id: string, sequence: number, offsetDays: number): DunningStage => ({
  id,
  sequence,
  offsetDays,
  name: `stage ${sequence}`,
  subjectTemplate: "",
  bodyTemplate: "",
  escalate: false,
});

const ladder = [stage("a", 1, 0), stage("b", 2, 15), stage("c", 3, 30)];

test("selectDueStage fires the highest crossed stage that has not fired", () => {
  assert.equal(selectDueStage(ladder, 40, new Set())?.id, "c");
  assert.equal(selectDueStage(ladder, 20, new Set())?.id, "b");
  assert.equal(selectDueStage(ladder, 3, new Set())?.id, "a");
});

test("selectDueStage never re-sends a stage already in the log", () => {
  assert.equal(selectDueStage(ladder, 40, new Set(["c"]))?.id, "b");
  assert.equal(selectDueStage(ladder, 40, new Set(["c", "b"]))?.id, "a");
  assert.equal(selectDueStage(ladder, 40, new Set(["c", "b", "a"])), null);
});

test("selectDueStage returns null before the first threshold", () => {
  const future = [stage("x", 1, 7)];
  assert.equal(selectDueStage(future, 3, new Set()), null);
});

test("renderTemplate substitutes known tokens and blanks unknown ones", () => {
  assert.equal(
    renderTemplate("Hi {{party}}, invoice {{invoice}} is {{daysOverdue}} days late.", {
      party: "Acme",
      invoice: "INV-100",
      daysOverdue: 12,
    }),
    "Hi Acme, invoice INV-100 is 12 days late.",
  );
  assert.equal(renderTemplate("{{missing}} tail", {}), " tail");
});
