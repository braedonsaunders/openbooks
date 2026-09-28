import type { DocArticle } from '../types'

export const busySeasonCapacity: DocArticle = {
  slug: 'busy-season-capacity',
  title: 'Busy-Season Capacity',
  category: 'projects',
  order: 3,
  summary:
    'Read department demand curves for the busy season from stored asks and the staffing plan, compare them with net capacity, and turn a gap into a draft resource request.',
  updated: '2026-09-28',
  keywords: ['busy season', 'capacity', 'demand curve', 'staffing plan', 'resource request', 'practice', 'peak', 'gap'],
  related: ['project-types', 'labor-costing'],
  body: `# Busy-Season Capacity

Accounting firms live the same year twice: a quiet summer and a spring where
every practice wants more hours than it employs. The resourcing cockpit's busy
season panel answers the seasonal version of the staffing question: for each
practice and each peak week, how many hours are claimed, how many hours exist,
and where the two differ. Every figure traces to the rows it was computed
from, and a gap never books anyone by itself. Turning a gap into people takes
one operator confirmation and creates a draft resource request, nothing more.

## The seasonal spans come from the plan

The panel never consults a calendar table. It reads the active staffing plan
for generic rows — plan assignments that name a job title instead of a
person — and the distinct weeks carrying those rows in the year form one or
more contiguous spans. Peak demand is staffed generically before it is staffed
by name, so those markers are the seasonal shape. A year with no generic
markers has no busy season in this sense, and the panel says so instead of
inventing one.

## What counts as demand

Inside those exact weeks, department load has two landed sources:

- Stored asks. Manual demand lines at full weight, plus opportunity-linked
  lines weighted live by the CRM probability through the same pipeline
  predicate the forecast uses. A probability change reprices the ask with no
  sync. Lines whose opportunity left the pipeline contribute zero and stay out
  of the sum.
- The staffing plan. Active plan assignments in the week, hard and soft, named
  and generic. Named rows attribute to the employee's active department;
  generic rows attribute to the single department that holds the title.

Attribution is total or it refuses. A named plan whose person has anything
other than exactly one active department, and a generic plan whose title is
held across departments or by nobody, stop the panel with a named refusal and
a remedy on the employee record. A curve that quietly dropped its largest row
would be worse than no curve.

Out-of-scope rows never enter: demand lines and plan rows outside the
operator's subsidiaries are excluded, and the confirmation list of projects
likewise carries only engagements inside scope.

## What counts as capacity

Net capacity comes only from the availability reader: the resolved schedule
tier (or the labor-costing standard when no schedule resolves), minus observed
holidays minus time off, floored at zero. A week whose load is positive but
whose capacity is partly unknown refuses with the unknown-capacity remedy
instead of publishing a partial gap. Staff who cannot be placed in exactly
one practice stop the panel with a named remedy on the employee record
instead of being silently left out of the totals.

## Gaps, and what is omitted

A gap is claimed load minus net capacity, kept only when positive. Weeks that
meet capacity exactly and weeks with room to spare are omitted, so the panel
shows only weeks that need a decision. Each row drills to its evidence:
demand lines open in the demand drawer, the weighting opportunities in the
CRM, plan rows in the assignments drawer, staff in the employee drawer,
absences in the leave queue, and holidays in the holiday setup.

## From a gap to a draft request

Each gap row offers one action. It asks for the engagement project, then
creates a draft resource request for the gap week at the gap hours under the
row's leading job title, with a reason citing the department, the week, and
the figures. The request lands as a draft: editable, unapproved, unsubmitted.
Approval still goes through the approval flow, and submitting still happens
from the request itself. There is deliberately no auto-booking and no
auto-submission; committing people is a control decision, and the panel does
not make it.

When the resource-requests capability is off, the action is absent rather than
dead, and the panel names the remedy: turn the capability on under Company
Settings, then Features. Turning capabilities off preserves every row the
panel reads.

## Limits worth knowing

One plan of record exists: there are no scenario versions to compare, and the
panel does not rank candidates or fill roles automatically. Tenant custom
reports over the computed capacity facts remain a later extension; planned
hours stay reportable through the registered assignment source today.
`,
}
