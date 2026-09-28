import type { DocArticle } from '../types'

export const softHardBookings: DocArticle = {
  slug: 'soft-hard-bookings',
  title: 'Soft versus Hard Bookings',
  category: 'projects',
  order: 5,
  summary:
    'What soft and hard bookings promise, how each moves through the staffing workflow, and how they compare across systems.',
  updated: '2026-09-28',
  keywords: ['soft booking', 'hard booking', 'tentative', 'confirmed', 'staffing', 'planning'],
  related: ['busy-season-capacity', 'staffing-board-evidence', 'project-types'],
  body: `# Soft versus Hard Bookings

Every assignment carries a booking type: soft or hard. The distinction is a
promise about certainty. A soft booking says this work is likely and the
person is penciled in; a hard booking says the work is committed and the
person's capacity is spent. The board, the utilization forecast, and the
busy-season panel all read the same flag, so a tentative plan can never look
committed in one place and tentative in another.

## What soft means

Soft bookings hold a place in the plan without consuming commitment. They
appear in demand totals and in the staffing board's soft column, and they
attrit naturally: when a draft resource request is cancelled or an
opportunity dies, its soft rows are released rather than converted. Use soft
for pipeline coverage, tentative extensions, and any plan that still needs a
signature.

## What hard means

Hard bookings consume capacity. They reduce available hours, drive
overallocation flags, and feed billable utilization. Only hard bookings count
toward the capacity fill that managers staff against. Converting soft to hard
is an explicit operator action on the assignment — the system never promotes
a booking on its own, because silent promotion would spend capacity nobody
approved.

## How the two travel together

A new assignment defaults to hard, since most day-to-day bookings are
commitments. Planners working ahead of confirmation choose soft at creation.
Either type can be changed later, and each change is an ordinary edit with
the usual audit trail. Releases and deletions behave identically for both:
actual time is preserved, and plan-versus-actual evidence survives the
booking row.

## How other systems name the same idea

Teams arriving with history elsewhere will recognize the pattern under
different names. OpenAir distinguishes booking types along the same
tentative-to-committed axis, so OpenAir bookings map onto soft and hard by
intent, not by label — confirm what each legacy type promised before
mapping it. Odoo carries tentative staffing in planning slots, which enter
as soft bookings, while confirmed schedule lines enter as hard ones.
Dynamics 365 Business Central job planning lines describe committed project
work and map to hard bookings; pipeline coverage held anywhere else in
Business Central has no planning-line counterpart and enters as soft.
Nothing in this mapping is a connector: these are operator migration
readings, applied row by row through the assignment plan import, so every
mapped booking carries its evidence from the first day.
`,
}
