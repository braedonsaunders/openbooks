import type { DocArticle } from '../types'

export const staffingBoardEvidence: DocArticle = {
  slug: 'staffing-board-evidence',
  title: 'Staffing Board Evidence',
  category: 'projects',
  order: 4,
  summary:
    'Read the staffing board week by week: hard and soft bookings against net capacity, and the evidence behind every cell.',
  updated: '2026-09-28',
  keywords: ['staffing board', 'capacity evidence', 'bookings', 'availability', 'overallocation', 'bench'],
  related: ['busy-season-capacity', 'project-types', 'labor-costing'],
  body: `# Staffing Board Evidence

The staffing board answers one question per person per week: who is booked,
for how much, and what is left. Every cell carries its evidence, so a manager
never has to trust a colored bar. Open any person-week and the board shows the
assignments behind it, the capacity it measured against, and the leave,
holidays, and approved time that adjusted the figure.

## What a cell shows

Each person-week cell totals planned assignment hours, split into hard and
soft bookings, and compares the total with that person's net capacity for the
week. Available hours are capacity minus booked hours. When bookings exceed
capacity the week is flagged as overallocated rather than silently clipped,
so the overload stays visible until someone moves work or adds capacity.

People with no recorded capacity appear as unknown rather than zero. Zero
would pretend the person has no hours to give; unknown says the schedule is
missing and names the remedy, which is to give the person a cycle schedule
under Setup and Payroll work schedules.

## Where capacity comes from

Net capacity comes from one reader only. It resolves the person's schedule
tier for the week, or the labor-costing standard when no schedule resolves,
then subtracts observed holidays and approved time off, floored at zero. The
same reader serves the utilization forecast and the busy-season panel, so the
three surfaces can never disagree about what a week holds.

## Where bookings come from

Bookings are assignment rows: a project, a subject who is either a named
person or a generic job title, a Sunday week, and planned hours. Generic rows
carry demand that is not yet staffed by name; the board keeps them visible in
the demand strip rather than attributing them to people who were never asked.
Assignments released from the board stay on record for plan-versus-actual
evidence, so deleting a booking never rewrites history.

## Demand evidence alongside

Below the people grid, the board shows demand by week: generic bookings and
weighted staffing demand lines. Each demand figure traces to its lines, and
lines whose opportunity left the pipeline contribute zero and stay out of the
sum. Demand outside the operator's subsidiaries never enters the board at
all.

## A note on migrations

There is no connector import behind this board. Teams arriving from other
systems should know the mapping gap up front: ERPNext has no capacity object
that corresponds to a staffing board cell, so ERPNext capacity history cannot
be carried over row for row. Staffing plans arrive as assignment imports
through the assignment plan resource, and capacity is rebuilt from work
schedules in OpenBooks — the evidence chain starts clean on day one rather
than inheriting numbers nobody can audit.
`,
}
