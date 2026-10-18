import type { DocArticle } from "../types";

export const scheduling: DocArticle = {
  slug: "scheduling",
  title: "Scheduling",
  category: "projects",
  order: 13,
  summary:
    "How schedule boards book people by the day or by the shift, run managed shift rosters with recurring patterns, shift requests and device attendance, schedule project tasks on a Gantt, publish changes, and offer booked time to timesheets, crew sheets and the people themselves.",
  updated: "2026-10-18",
  keywords: [
    "scheduling",
    "schedule board",
    "manpower",
    "dispatch",
    "shift roster",
    "shift pattern",
    "shift swap",
    "attendance",
    "time clock",
    "booking",
    "crew schedule",
    "gantt",
    "production progress",
    "my schedule",
  ],
  related: ["crew-time-entry", "field-clock-in", "leave-time-versus-value", "flows"],
  body: `# Scheduling

Scheduling is one workspace for every way a company plans its people and
its projects. Each **board** is a schedule for one part of the business: a
crew sent to customers by the day, a store team on hourly shifts, a plant
running round the clock, or the projects on a Gantt. Open it from People,
then Scheduling.

## Boards

A board has a row type and a scope. **People boards** list the employees
of a legal entity, department or location; **task boards** list the tasks
of one project or of every active project in scope. Several boards can run
at once, and a person booked on one board shows on every other board as
read-only, so nobody is ever shown free while they are booked elsewhere.

Create boards in Setup, then Schedule boards, or with **New board** in the
workspace, which starts from a preset:

- **Day dispatch** books each person to a customer, site, project or code
  for the board's working day, two weeks at a time, publishing as you book.
- **Shift roster** books start and end times by the hour and collects the
  week's changes until it is published.
- **Round-the-clock operations** plans day and night shifts that cross
  midnight four weeks at a time.
- **Managed shift roster** is a board type of its own: hourly shifts plus
  recurring shift patterns, employee shift requests, optional governed
  publication and time-clock attendance, described below.
- **Project schedule** shows project tasks on a Gantt with dependencies,
  the critical path and resource levelling, plus production progress.

Every preset only fills the settings; all of them stay editable. A board's
type is fixed when it is created: an existing people board keeps working
exactly as before, and the roster tools appear only on managed shift
rosters.

## Booking people

In the **Grid**, select a cell and type a code. The list offers schedule
codes, customers, projects and locations; Enter books it. Select a range
first to book every selected cell at once. Text after a slash becomes the
booking's detail (PLANT/kiln 2), and a trailing range books hours instead
of the day (SHOP 6-14:30).

The grid works like a spreadsheet: arrow keys and Tab move, Shift extends
the selection, Delete clears it, Ctrl+C and Ctrl+V copy and paste, Ctrl+D
and Ctrl+R fill down and right, and the handle at the corner of a
selection repeats it. Cells copied from a spreadsheet paste as codes. Drag
a booking to move it to another person or day, or hold Alt to copy it.
Undo and redo step back through every saved change.

Recorded leave and holidays from the business calendar show in the grid,
and days with leave are skipped when booking. Double-click a booking to
set its project task, hours, break, detail and notes, or to repeat it on
other days.

**By job** turns the same bookings around: one row per job with the people
sent there each day, and a list of who is still free to drag onto a job.
**Timeline** shows the hours, with drag to move or resize and drag on an
empty row to book new hours. **Month** shows who is where across the month,
or one person's month.

## Publishing and history

On a **live** board a booking is published as soon as it is made. On a
**staged** board changes stay drafts until someone with permission to
approve schedules publishes them; publication is all or nothing, and any
booking that cannot publish, for example because of leave or a booking on
another board, is listed with its reason. A published booking is never
rewritten: changing it cancels it and records the replacement, so the
history of who was sent where is kept and every change is audited.

## Managed shift rosters

A managed shift roster is a people board with hourly shifts and a
**Roster** button in the toolbar. Its tabs hold the tools the roster type
adds; each one goes through the same booking, publication and audit rules
as the rest of the board.

**Recurring shifts.** Define shift patterns in Setup, then Shift patterns:
a cycle length in days, the date that is day 0, the pattern's time zone,
and each shift's cycle day, local start and end times, break and any
required qualifications. On the Roster, assign a pattern to a person from a
date, optionally through a date. The pattern books that person's shifts
for its look-ahead window and keeps them current every day. Generation is
repeatable and never duplicates a shift: a booking you change by hand is
kept as changed, a shift that has started is never touched, and removing a
generated booking records it as skipped so it is not booked again. Skip a
single day, end the assignment from a date, or cancel it; future bookings
it made are removed. When a clock change makes a local time repeat, the
assignment asks which of the two real times to use; when a time does not
exist that day, the occurrence is reported instead of guessed.

**Shift requests.** Employees ask from Me, then Schedule, to release one of
their future published shifts, change its hours, or swap it with a
colleague's shift on the same board; a swap waits for the colleague to
accept first. Requests are subjects of the native approval Flows: when an
enabled Flow applies, the request waits in Approvals and is applied the
moment it is approved, by someone other than the person who asked. With no
Flow configured, the request applies as soon as it is sent and records that
no approval applied. The Roster lists open and recent requests for the
board.

**Governed publication.** A roster's publishing can be **governed** from a
chosen date. Publishing then records a publication of the submitted changes;
an approval Flow can decide it in Approvals, and without one it publishes
immediately. While a publication waits, its changes are locked. Once
published, a governed booking is kept as history: a change is a new
revision that publishes through the next publication, and removing a
booking is a removal draft that takes effect when published. Bookings
before the governed date keep the board's earlier rules.

**Attendance.** With Device attendance switched on, register time clocks in
Setup, then Attendance devices, map each device's worker identifiers to
people over dated windows, and set the roster's attendance policy (how long
before and after a shift a check-in counts, and the late, early-leave and
break grace minutes) under the board's settings. Policies are dated: a new
version applies from its date and never reinterprets earlier shifts.
Import a device's export as CSV from the Roster's Attendance tab, naming
the instant up to which the device is complete; importing the same file
again records nothing twice. Observing attendance compares published
shifts with the check-ins and shows **Late**, **Early**, **Absent** and
**Break** badges on the board; a shift whose device has not yet sent every
check-in shows as waiting for the device. The **Attendance exceptions**
report in Reports lists every flagged shift for a period. With Formal shift
closing switched on, an ended shift with complete attendance can be closed
from its drawer, after which it cannot change. Attendance never becomes
approved time or pay on its own: timesheets and payroll keep their own
approvals.

## Pre-fill and notifications

A people board can offer its published bookings to the editors that record
actual work. With **Pre-fill timesheets** on, each person's weekly timesheet
shows **Fill from schedule**, which adds the booked hours to empty days for
them to review and save. With **Pre-fill crew time** on, the foreman's crew
sheet for a project and day offers the people booked there. Nothing is
recorded until the person or foreman saves, so the timesheet and crew
approval rules apply unchanged.

With **Pre-fill field tickets** on, a draft ticket's Crew hours tab offers
**Fill from schedule** for its project and period. Published bookings add
the scheduled hours and task assignments only to empty person-days; existing
hours and unfinished edits are preserved. When several regular time types
are available, choose one before filling. Review the crew and labor items,
then save through the ticket's normal approval workflow.

With **Email people their changes** on, everyone whose published bookings
change receives a notification in OpenBooks and, when the organization has
email set up and the person has an address, an email listing the days that
changed. Everyone can see their own published bookings under Me, then
Schedule.

## Production progress

On a task board, **Progress** lists each task's budget hours, the approved
hours charged to it and its percent complete. Earned hours are percent
complete times budget hours; productivity is earned hours divided by
actual hours; hours to complete assume the pace so far continues. Editing
the percent here updates the Gantt.

## Access

Viewing people boards needs permission to view shift plans, booking needs
permission to manage them, and publishing a staged or governed board needs
permission to approve them. Employees need permission to file their own
requests to ask for shift changes. Importing check-ins and managing devices
needs permission to manage attendance; the Attendance exceptions report
needs permission to view it. Task boards use the project permissions.
Scheduling is switched on with Human Resources on Company Settings, then
Features; task boards also need Project Scheduling, roster attendance needs
Device attendance, and closing shifts needs Formal shift closing.
`,
};
