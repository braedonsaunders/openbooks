import type { DocArticle } from "../types";

export const fieldClockIn: DocArticle = {
  slug: "field-clock-in",
  title: "Clocking in from the field",
  category: "projects",
  order: 11,
  summary:
    "How crews clock in from a phone or a site kiosk: projects and cost codes at clock-in, geofence flags, photos, breaks, switches, and the offline queue.",
  updated: "2026-09-21",
  keywords: [
    "clock in",
    "clock out",
    "kiosk",
    "geofence",
    "offline time",
    "break",
    "switch project",
    "cost code",
    "PIN",
    "field time",
  ],
  related: ["labor-costing", "field-tickets", "payroll"],
  body: `# Clocking in from the field

Deskless crews do not fill a weekly grid. Field time capture is a
mobile-first clock page and a site kiosk page that record clock events
and pair them into time entries — the grid stays the office path, and
both paths land in the same timesheet weeks and the same approvals.

## The clock page

Open Time entry, then Clock. One state card tells the truth (clocked
out, or clocked in since 07:02 on Project X, cost code Y), one primary
button clocks in or out, and a picker sheet chooses the project, task,
and cost code — recent first, searchable. The break button opens a
break; the switch button changes project or cost code mid-day without
closing the shift.

Clock-out pairs the shift into entries: hours come from device times,
rounded per the org's declared rounding rule and reduced by breaks per
the declared break rule. Entries land submitted in the week's timesheet
and price through the normal labor-costing resolution at approval.

## Place and identity are flags, not walls

When the project declares a geofence, the clock checks the device fix
against it. An outside fix is RECORDED anyway — a worker must be able
to clock — and flagged for the approver, who sees the flag chip in the
approvals page. The same holds for an unavailable fix (no permission,
no signal). Raw coordinates never leave the approval drawer and the
coordinates report; every other surface carries flags only.

Kiosks are shared devices opened from a device link: the worker finds
their name, enters their PIN, and clocks. A PIN is a kiosk identity,
never a password — five wrong tries lock kiosk sign-in for fifteen
minutes. Kiosks that require photos refuse the clock without one. The
kiosk returns to idle after twenty seconds so the next worker starts
clean.

## Offline is a queue, not an excuse

With no signal the page queues events on the device and shows the
queued count. Reconnecting replays the queue through the same API:
each event carries the offline id it was born with, so replaying the
same queue twice records every event once. Results come back per
event — one bad event never sinks the rest.

## Rules worth knowing

Clocking in while clocked in refuses; clocking out with no open pair
refuses — the service never silently pairs. A pair left open past the
org's auto-close window closes itself with a flag, never silently.
Rounding, break, and auto-close rules are declared in Timesheets setup
before anyone clocks in; there are intentionally no silent defaults.
`,
};
