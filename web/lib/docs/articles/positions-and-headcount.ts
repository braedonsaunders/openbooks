import type { DocArticle } from "../types";

export const positionsAndHeadcount: DocArticle = {
  slug: "positions-and-headcount",
  title: "Positions and the headcount plan",
  category: "projects",
  order: 5,
  summary:
    "Plan the funded establishment with positions, fund each position per fiscal period, staff it through change requests, and read planned versus funded versus filled FTE as of any date.",
  updated: "2026-09-20",
  keywords: [
    "position",
    "headcount plan",
    "establishment",
    "vacancy",
    "planned FTE",
    "funded FTE",
    "filled FTE",
    "vacant",
    "over-filled",
    "under-funded",
    "position assignment",
    "unassign",
    "close position",
    "funding",
    "cost plan",
    "headcount",
  ],
  related: ["payroll", "labor-costing"],
  body: `# Positions and the headcount plan

A position is one funded establishment slot: a code, a title, a department,
a location, a legal employer, and a planned FTE with a lifecycle status
(planned, open, filled, frozen, closed). People never live on positions.
Employments and their assignments name a position when they hold it, and the
headcount plan compares three numbers as of any date: planned FTE (the
establishment), funded FTE (the plan for the fiscal period), and filled FTE
(the live primary assignments holding the slot).

## Open a position

Positions live on the HRM Positions tab behind the position read grant, and
are written behind the position manage grant. Opening a position records the
first version with its effective window and a reason; every later change
appends a new version with its own reason, and the full history stays
readable. Position codes are unique per organization and never change: a
renamed establishment is a new position, so history cannot be orphaned by an
edit.

## Fund each period

Funding is one plan row per position and fiscal period: funded FTE plus an
optional cost-plan amount with its currency. Funding outside zero to planned
is legitimate — plans over- and under-fund — so the write always applies and
reports the comparison as a named preflight instead of rejecting the row.
Re-planning a period rewrites the same row with a new reason; the prior plan
stays in the position's evidence.

## Staff through change requests

An employment takes a position through a position_assignment change request,
approved the same way as every other employment change. Only the link moves:
title, department, location, FTE, and primary stay on the assignment, and any
disagreement with the position is recorded as a warning in both histories,
never applied as a rewrite. Clearing the link is an explicit unassignment,
never an emptied field.

## Read vacancy as of a date

The Positions tab lists every established position with planned, funded,
filled, and vacant FTE, segmented by lifecycle status; a row opens the
position drawer with its versions, funding by period, and current holder.
The HRM overview carries open positions, unfunded filled FTE, and vacancy by
department. The Positions workforce report gives the same as-of statement in
the report engine, and the assistant's positions read tool answers vacancy
questions from the same service.

## Close a position

Closing retires the establishment at an effective date and is refused while
a live primary assignment still names it: unassign the holder first, then
close. Closed is terminal; a retired establishment never reopens.
`,
};
