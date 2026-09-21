import type { DocArticle } from "../types";

export const certifiedPayrollPrevailingWagePerDiem: DocArticle = {
  slug: "certified-payroll-prevailing-wage-per-diem",
  title: "Certified payroll, prevailing wage and per diem",
  category: "projects",
  order: 10,
  summary:
    "How rate schedules price project hours by classification and date, how frozen certified reports render through the payroll pack's declared files, and how per-diem crosses into payroll.",
  updated: "2026-09-20",
  keywords: [
    "certified payroll",
    "prevailing wage",
    "union rate",
    "work classification",
    "apprentice ratio",
    "per diem",
    "travel pay",
    "workers comp class",
    "compliance finding",
  ],
  related: ["payroll", "labor-costing", "employment-migration"],
  body: `# Certified payroll, prevailing wage and per diem

A construction hour is priced by project location, classification, and
date — never by the wage rate on the employment alone. The org declares
work classifications (journey and apprentice trades) and rate schedules
(prevailing-wage, union-agreement, or org-declared) with scope
(project, location, subsidiary, or whole org) and reciprocity (home
local, jobsite local, or higher of). The resolver takes the most
specific schedule in scope, the employment's classification as of the
day, and prices from the covering line. A day with no covering line is
refused by name and flagged as a missing-rate finding — it never falls
back to the employment wage silently.

Every rate source, class list, and rule is a pack declaration or an
org-declared table. The generic layer branches on no jurisdiction: the
payroll pack declares its labor-compliance files (the US pack its
federal weekly form and a state XML; a pack with none refuses generation
by name), and the Canadian pack declares its construction carve-outs as
cited, effective-dated data. Jurisdiction codes ride free text the packs
interpret.

Certified payroll freezes one row per worker per classification per day
(hours from approved time, rates from the resolver, deductions from the
posted runs covering the week) and renders the frozen payload through
the pack's declared file builder. The rendered file is stored on the run
and filed in the File Cabinet under the project's folder; submitting
marks it filed, and amending builds a new run linked to the original.

Apprentice ratios count apprentice against journey hours per rule from
approved time. A breach writes a ratio-breach finding AND reprices that
day's apprentice hours at the journey line — both visible, neither
silent. Workers'-comp classes resolve by highest-priority match; an hour
no rule matches is refused with an unresolved-class finding, never a
default class.

Per-diem and travel pay compute from approved time (flat daily,
distance brackets, or hours threshold, with lodging offset and a worked-to-paid
weekly rule) and cross into payroll ONLY as allowance-seam rows keyed by
entry. Approval writes the seam row; voids carry a reason; a row a pay
run consumed refuses voids naming the run. Taxability lives on the
linked earning component's tax treatment — the policy names the
component and shows its treatment read-only.
`,
};
