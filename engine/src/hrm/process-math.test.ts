import { checklistStep } from "../testing/checklist-documents.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  addOffsetDays,
  isStepOverdue,
  ProcessMathError,
  resolveTemplateForEmployment,
  snapshotTemplateSteps,
  summarizeProgress,
} from "./process-math.ts";

const step = (overrides: Record<string, unknown> = {}) => ({
  ...checklistStep({ id: 'step-1', title: 'Collect documents', description: null, ownerKind: 'hr', evidenceKind: 'none' }),
  position: 0, ...overrides,
});

test("offsets walk the civil grid across month, year, and leap boundaries", () => {
  assert.equal(addOffsetDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addOffsetDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addOffsetDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addOffsetDays("2023-02-28", 1), "2023-03-01");
  assert.equal(addOffsetDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addOffsetDays("2026-06-15", 0), "2026-06-15");
  assert.equal(addOffsetDays("2026-06-15", -30), "2026-05-16");
});

test("offsets refuse non-integers and out-of-range results", () => {
  assert.throws(() => addOffsetDays("2026-06-15", 1.5), ProcessMathError);
  assert.throws(() => addOffsetDays("2026-06-15", Number.NaN), ProcessMathError);
  assert.throws(() => addOffsetDays("9999-12-31", 1), /leaves the supported calendar/);
  assert.throws(() => addOffsetDays("0001-01-01", -1), /leaves the supported calendar/);
  assert.throws(() => addOffsetDays("not-a-date", 3), /invalid civil date/);
});

test("overdue is strictly-before-today while pending, never when terminal", () => {
  assert.equal(isStepOverdue({ dueOn: "2026-06-14", today: "2026-06-15", status: "pending" }), true);
  assert.equal(isStepOverdue({ dueOn: "2026-06-15", today: "2026-06-15", status: "pending" }), false);
  assert.equal(isStepOverdue({ dueOn: "2026-06-16", today: "2026-06-15", status: "pending" }), false);
  assert.equal(isStepOverdue({ dueOn: "2026-06-01", today: "2026-06-15", status: "done" }), false);
  assert.equal(isStepOverdue({ dueOn: "2026-06-01", today: "2026-06-15", status: "skipped" }), false);
  assert.throws(
    () => isStepOverdue({ dueOn: "2026-06-01", today: "2026-06-15", status: "archived" }),
    /unknown step status "archived"/,
  );
});

test("progress reports exact counts, never a float", () => {
  const summary = summarizeProgress([
    { required: true, status: "done" },
    { required: true, status: "pending" },
    { required: false, status: "pending" },
  ]);
  assert.deepEqual(summary, { total: 3, required: 2, doneRequired: 1, allRequiredDone: false });
  assert.deepEqual(summarizeProgress([]), {
    total: 0,
    required: 0,
    doneRequired: 0,
    allRequiredDone: true,
  });
  assert.equal(
    summarizeProgress([
      { required: true, status: "done" },
      { required: true, status: "skipped" },
    ]).allRequiredDone,
    false,
  );
  assert.throws(() => summarizeProgress([{ required: true, status: "archived" }]), /unknown step status/);
});

test("snapshots copy the template in position order with concrete due dates", () => {
  const snapshots = snapshotTemplateSteps(
    "tpl-1",
    [
      step({ id: "b", position: 1, dueOffsetDays: 7, ownerKind: "manager" }),
      step({ id: "a", position: 0, dueOffsetDays: -3, title: "Prepare desk" }),
    ],
    "2026-09-01",
  );
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0]!.templateStepId, "a");
  assert.equal(snapshots[0]!.dueOn, "2026-08-29");
  assert.equal(snapshots[1]!.templateStepId, "b");
  assert.equal(snapshots[1]!.dueOn, "2026-09-08");
});

test("snapshots refuse empty, duplicated, and malformed templates by name", () => {
  assert.throws(() => snapshotTemplateSteps("tpl-empty", [], "2026-09-01"), /carries no steps/);
  const invalid: Array<[string, ReturnType<typeof step>[], RegExp]> = [
    ['tpl-dupe', [step({ id: 'a', position: 0 }), step({ id: 'b', position: 0 })], /lists position 0 twice/],
    ['tpl-owner', [step({ ownerKind: 'peer' })], /names owner "peer"/],
    ['tpl-party', [step({ ownerKind: 'hr', ownerPartyId: 'p-1' })], /pairs owner hr with a party/],
    ['tpl-evidence', [step({ evidenceKind: 'video' })], /names evidence "video"/],
    ['tpl-blank', [step({ title: '  ' })], /blank title/],
  ];
  for (const [id, steps, message] of invalid) {
    assert.throws(() => snapshotTemplateSteps(id, steps, '2026-09-01'), message);
  }
});

test("template resolution prefers the most specific cover and refuses ties by id", () => {
  const employment = { employerSubsidiaryId: "sub-1", departmentId: "dep-1" };
  const general = { id: "tpl-general", employerSubsidiaryId: null, departmentId: null };
  const employer = { id: "tpl-employer", employerSubsidiaryId: "sub-1", departmentId: null };
  const exact = { id: "tpl-exact", employerSubsidiaryId: "sub-1", departmentId: "dep-1" };
  assert.equal(resolveTemplateForEmployment("onboarding", [general, employer, exact], employment).id, "tpl-exact");
  assert.equal(resolveTemplateForEmployment("onboarding", [general, employer], employment).id, "tpl-employer");
  assert.throws(
    () => resolveTemplateForEmployment("onboarding", [], employment),
    /no active onboarding template covers this employment/,
  );
  // A REALISTIC tie: two different checklists, both covering — the message
  // must name both ids so the operator can tell them apart.
  const first = { id: "tpl-day-one", employerSubsidiaryId: "sub-1", departmentId: null };
  const second = { id: "tpl-first-week", employerSubsidiaryId: null, departmentId: "dep-1" };
  assert.throws(
    () => resolveTemplateForEmployment("onboarding", [first, second], employment),
    /tpl-day-one.*tpl-first-week|tpl-first-week.*tpl-day-one/,
  );
  // Non-covering filters never match, even when they are the only option.
  assert.throws(
    () =>
      resolveTemplateForEmployment("onboarding", [{ id: "tpl-other", employerSubsidiaryId: "sub-9", departmentId: null }], employment),
    /no active onboarding template/,
  );
});
