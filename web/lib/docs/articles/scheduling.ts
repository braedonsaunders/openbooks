import type { DocArticle } from "../types";

export const scheduling: DocArticle = {
  slug: "scheduling",
  title: "Scheduling",
  category: "projects",
  order: 13,
  summary:
    "How schedule boards book people by the day or by the shift, schedule project tasks on a Gantt, publish changes, and offer booked time to timesheets, crew sheets and the people themselves.",
  updated: "2026-10-07",
  keywords: [
    "scheduling",
    "schedule board",
    "manpower",
    "dispatch",
    "shift roster",
    "booking",
    "crew schedule",
    "gantt",
    "production progress",
    "my schedule",
  ],
  related: ["crew-time-entry", "field-clock-in", "leave-time-versus-value"],
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
- **Project schedule** shows project tasks on a Gantt with dependencies,
  the critical path and resource levelling, plus production progress.

Every preset only fills the settings; all of them stay editable.

## Booking people

In the **Grid**, select a cell and type a code. The list offers schedule
codes, customers, projects and locations; Enter books it. Select a range
first to book every selected cell at once. Text after a slash becomes the
booking's detail (BIRLA/kiln 2), and a trailing range books hours instead
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

## Pre-fill and notifications

A people board can offer its published bookings to the editors that record
actual work. With **Pre-fill timesheets** on, each person's weekly timesheet
shows **Fill from schedule**, which adds the booked hours to empty days for
them to review and save. With **Pre-fill crew time** on, the foreman's crew
sheet for a project and day offers the people booked there. Nothing is
recorded until the person or foreman saves, so the timesheet and crew
approval rules apply unchanged.

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
permission to manage them, and publishing a staged board needs permission
to approve them. Task boards use the project permissions. Scheduling is
switched on with Human Resources on Company Settings, then Features; task
boards also need Project Scheduling.
`,
};
