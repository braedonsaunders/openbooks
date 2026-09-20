import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROJECTS_DETECTOR_KEYS } from "../agents/projects.ts";
import {
  defaultContinuousCloseDetectors,
  detectorSpecsForAgent,
  enabledDetectorKeys,
  normalizeContinuousCloseDetectors,
} from "../agents/continuous-close-config.ts";

const source = readFileSync(new URL("../agents/projects.ts", import.meta.url), "utf8");

test("the project-margin pack owns three detectors, on by default", () => {
  assert.deepEqual([...PROJECTS_DETECTOR_KEYS], [
    "project_negative_margin",
    "project_budget_overrun",
    "project_stale_unbilled",
  ]);
  assert.deepEqual(
    detectorSpecsForAgent("projects").map((spec) => spec.detectorKey),
    [...PROJECTS_DETECTOR_KEYS],
  );
  const defaults = defaultContinuousCloseDetectors("projects");
  for (const key of PROJECTS_DETECTOR_KEYS) {
    assert.ok(
      enabledDetectorKeys(defaults).includes(key),
      `${key} defaults on`,
    );
  }
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("projects", {
        project_stale_unbilled: { parameters: { unbilledDays: 0 } },
      }),
    /invalid detector parameter/,
  );
});

test("project margin reuses the ranking query and the WIP billing predicates", () => {
  // Margin and overrun come from the SAME row the margin report ranks:
  // primary-book posted/reversed lines classified by account-type sets, the
  // approved task budgets, and the approved-PO unbilled commitments.
  assert.match(source, /e\.status in \('posted', 'reversed'\)/);
  assert.match(source, /type in \$\{costSet\}/);
  assert.match(source, /sum\(t\.estimated_cost\)/);
  assert.match(source, /d\.kind = 'purchase_order'/);
  assert.match(source, /dl\.quantity > dl\.quantity_billed/);
  // The report's own negative-margin and over-budget predicates — never a
  // second copy of either — under the materiality floor.
  assert.match(source, /cmp\(row\.margin, "0"\) >= 0/);
  assert.match(source, /cost \+ committed past the/);
  // A flipped margin reads the previously persisted margin off the stable
  // fingerprint, so the card can say the project crossed into the red.
  assert.match(source, /from ai_work_items/);
  assert.match(source, /project-negative-margin:\$\{row\.id\}/);
  assert.match(source, /crossedIntoNegative/);
  // Stale unbilled work reuses the WIP billing service's eligibility
  // predicates (approved + billable + uninvoiced time at bill rate, billable
  // uninvoiced document lines at the bill-amount cascade) minus the holds
  // and open-prebill reservations the service excludes; a cutoff replaces
  // the service's billing window.
  assert.match(source, /te\.billing_status = 'unbilled'/);
  assert.match(source, /coalesce\(te\.bill_rate, item\.default_rate, 0\)/);
  assert.match(source, /line\.billed_by_line_id is null/);
  assert.match(source, /line\.markup_percent is not null/);
  assert.match(source, /wip_holds hold/);
  assert.match(source, /wip_prebill_lines reserved/);
  assert.match(source, /te\.worked_on <= \$\{cutoff\}/);
  // No prebill-creation tool exists, so the finding is the review card —
  // the pack never proposes an execution it cannot name.
  assert.ok(!source.includes("proposal:"), "stale unbilled carries no execution proposal");
  assert.match(source, /agentKey: "projects"/, "findings belong to the projects pack");
  for (const fingerprint of [
    "project-negative-margin:",
    "project-budget-overrun:",
    "project-stale-unbilled:",
  ]) {
    assert.ok(source.includes(fingerprint), `fingerprint ${fingerprint}* is stable`);
  }
});
