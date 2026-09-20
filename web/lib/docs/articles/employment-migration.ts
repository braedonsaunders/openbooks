import type { DocArticle } from "../types";

export const employmentMigration: DocArticle = {
  slug: "employment-migration",
  title: "Employment migration",
  category: "projects",
  order: 7,
  summary:
    "Why some employee parties have no employment record yet, what headcount excludes until they are migrated, and how to migrate them.",
  updated: "2026-09-20",
  keywords: [
    "employment",
    "migration",
    "headcount",
    "employee record",
    "unmigrated",
    "change request",
    "hire",
    "readiness",
  ],
  related: ["payroll"],
  body: `# Employment migration

People and employments are different records. A person becomes visible in the
workspace the moment they are added as an employee party — that is the roster
the employee list shows. An employment record is the governed history behind
that person: status, effective dates, assignments, and every change with its
reason. Headcount, the department board, and the workforce reports read only
employment records, so an employee party without one is invisible to all three.

The Human Resources cockpit is honest about the gap. Its readiness panel
counts the active employee parties that have no employment record and says so
in plain words: those employees are not yet migrated to employment records and
headcount excludes them. A zero on the cockpit is always a resolved zero —
nobody in service on the date — never a migration gap pretending to be data.

Migration is deliberate, one employment at a time. Open the employee record,
propose a hire change with the effective start date, and submit it: the
approval run decides, and the decision writes the first effective version onto
the canonical record. The employment appears in headcount on and after its
effective start date, backdated correctly as of any later reporting date
because the history is bitemporal. There is no bulk import for this step — a
hire is an attested event with a reason, and unattested rows would poison the
history every later report trusts.

Until an employment exists, the employee drawer says so instead of guessing:
it renders the explicit no-record state rather than an empty Employment tab.
If the drawer reports more than one employment record for the same person,
resolve the duplicates before reading as-of state — identity is per
employment and the reader never picks one silently.

Probation periods are not modeled on the employment record: the temporal
model exposes status and the effective window only, so the cockpit names
upcoming starts and ends from effective dates and says plainly that probation
tracking lives outside the record.
`,
};
