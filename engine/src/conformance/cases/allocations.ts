/**
 * Allocation kernel — internal-controls evidence cases.
 *
 * Each case pins one invariant of docs/design/allocation-kernel.md §5 as an
 * executable fixture and maps to its AUDIT-CONTROLS.md control id. These are
 * OpenBooks' own controls, not requirements of a published accounting
 * standard, so they carry `control` instead of `citations` and are published
 * in the internal-controls matrix — never in the standards matrix.
 */

import { apportion, fixedPercentWeights } from "../../allocations/apportion.ts";
import { explodeDocumentLine } from "../../allocations/entry.ts";
import type { AllocationRuleTarget, RuleInEffect } from "../../allocations/types.ts";
import { fromUnits, toUnits } from "../../money.ts";
import type { ActualOutcome } from "../types.ts";
import type { ControlCase } from "../controls.ts";

function sumAmounts(amounts: string[]): string {
  let total = 0n;
  for (const amount of amounts) total += toUnits(amount);
  return fromUnits(total);
}

function target(
  id: string,
  sequence: number,
  fixedPercent: string,
  departmentId: string,
  label: string,
): AllocationRuleTarget {
  return {
    id,
    sequence,
    targetAccountId: null,
    departmentId,
    locationId: null,
    classId: null,
    projectId: null,
    subsidiaryId: null,
    extraDims: {},
    fixedPercent,
    weight: null,
    isRemainder: false,
    label,
  };
}

function entryRuleInEffect(targets: AllocationRuleTarget[]): RuleInEffect {
  return {
    rule: {
      id: "rule-overhead-split",
      orgId: "org-synthetic",
      key: "overhead-split",
      name: "Overhead split",
      mode: "entry",
      sortOrder: 100,
      isActive: true,
      isSystem: false,
    },
    version: {
      id: "version-overhead-split-1",
      orgId: "org-synthetic",
      ruleId: "rule-overhead-split",
      versionNo: 1,
      status: "published",
      effectiveFrom: "2026-01-01",
      bookScope: "primary",
      bookIds: [],
      accountScope: { kind: "any" },
      dimensionFilters: {},
      applyPolicy: "automatic",
      sourceMeasure: "period_activity",
      basisKind: "fixed_percent",
      driverAsOf: "document_date",
      basisConfig: {},
      targetKind: "explicit",
      dynamicTarget: {},
      impact: "reclass",
      residualPolicy: "largest_share",
      solveMethod: "sequential",
      runPolicy: "manual",
      runOffsetDays: 0,
      definitionHash: "synthetic",
    },
    targets,
  };
}

export const ALLOCATION_CONTROL_CASES: readonly ControlCase[] = [
  {
    id: "alloc-no-lost-cent",
    title: "Apportioning an indivisible total loses no cent",
    control: "A12",
    support: "supported",
    tier: "computation",
    assertion:
      "Splitting 100.00 across three equal weights assigns the entire 100.00 — the one-unit leftover lands deterministically on the first target and is recorded as residual, never dropped or invented.",
    facts: [
      "Total 100.00 over three equal weights of 1 with the largest-share residual policy.",
      "A hundredth of a cent of difference is a failure.",
    ],
    expected: {
      values: {
        a: "33.3334",
        b: "33.3333",
        c: "33.3333",
        sum: "100.0000",
        residual: "0.0001",
      },
    },
    run: (): ActualOutcome => {
      const result = apportion(
        "100.00",
        [
          { key: "a", weight: "1" },
          { key: "b", weight: "1" },
          { key: "c", weight: "1" },
        ],
        "largest_share",
      );
      const amounts = Object.fromEntries(result.targets.map((t) => [t.key, t.amount]));
      return {
        values: {
          a: amounts["a"]!,
          b: amounts["b"]!,
          c: amounts["c"]!,
          sum: sumAmounts(result.targets.map((t) => t.amount)),
          residual: sumAmounts(result.targets.map((t) => t.residual)),
        },
      };
    },
  },
  {
    id: "alloc-entry-group-sum",
    title: "Exploded entry children sum to the entered amount",
    control: "A12",
    support: "supported",
    tier: "computation",
    assertion:
      "A 1,000.01 bill line exploded by a 60/30/10 entry rule becomes children of 600.0060, 300.0030, and 100.0010 that sum to exactly the entered 1,000.01.",
    facts: [
      "Entry rule with explicit fixed-percent targets Engineering 60, Sales 30, Support 10.",
      "Entered line amount 1000.01 with no quantity.",
    ],
    expected: {
      values: {
        child1: "600.0060",
        child2: "300.0030",
        child3: "100.0010",
        sum: "1000.0100",
        residual: "0.0000",
      },
    },
    run: (): ActualOutcome => {
      const targets = [
        target("t-eng", 1, "60", "dept-eng", "Engineering"),
        target("t-sales", 2, "30", "dept-sales", "Sales"),
        target("t-support", 3, "10", "dept-support", "Support"),
      ];
      // The grid itself must be sound before the explosion means anything.
      fixedPercentWeights(targets);
      const exploded = explodeDocumentLine(
        { accountId: "role:cogs", amount: "1000.01" },
        entryRuleInEffect(targets),
        { groupId: "group-1" },
      );
      const amounts = exploded.children.map((child) => child.amount);
      return {
        values: {
          child1: amounts[0]!,
          child2: amounts[1]!,
          child3: amounts[2]!,
          sum: sumAmounts(amounts),
          residual: sumAmounts(exploded.apportionments.map((a) => a.residual)),
        },
      };
    },
  },
];
