import type { DocArticle } from "../types";

export const benefitsEnrollment: DocArticle = {
  slug: "benefits-enrollment",
  title: "Benefits: elections and the monthly payroll seam",
  category: "projects",
  order: 9,
  summary:
    "How benefit plans, enrollment windows, and elections work, why election amounts are stored and never rewritten, and how monthly amounts cross into payroll as pay-run inputs.",
  updated: "2026-09-20",
  keywords: [
    "benefits",
    "enrollment",
    "benefit plan",
    "coverage tier",
    "enrollment window",
    "dependent",
    "payroll input",
    "proration",
  ],
  related: ["payroll", "employment-migration", "leave-time-versus-value"],
  body: `# Benefits: elections and the monthly payroll seam

A benefit answers "what does the org provide this employment beyond pay?"
with a plan, a window, and an election. The plan names what is offered
(health, dental, retirement, ...) with the org's own cost figures; the
window names when people may elect (open enrollment, new hire, life
event); the election names who holds what from which date, with which
coverage tier and which dependents. Amounts cross into payroll ONLY as
pay-run input rows. HR owns the election; payroll owns the money movement.

Plans are org-declared, never a built-in list of one jurisdiction's
programmes. Kind is free text. Tax treatment lives on the linked pay
components, never on the plan: every input row names the component whose
treatment prices it, so the run reads amounts with no benefits-specific
logic. A plan that prices an employee cost must link a deduction
component; a plan that prices an employer cost must link an
employer_contribution component, or employer money could reach net pay —
saving such a plan is refused by name.

Election amounts are computed from the plan basis at election and STORED.
A later plan repricing never rewrites an existing election: changing an
active enrolment ends it and opens a new one from the change date. Tiers
(employee-only, family, ...) work the same way — the tier amounts are
copied onto the election, so repricing a tier never rewrites history.
Waiving is an evidenced row too, never silence.

Only whole months cross, one row per enrolment per coverage month per
kind. The row carries the amount HR means after HR-side proration: a
full_month plan carries the whole month whatever the effective dates, a
daily plan scales by covered days over days in month. Payroll allocates
months to pay periods and never recomputes; currency is stored from the
plan and never converted. Regeneration is idempotent — a retried month
lands on the same rows. A month a run already consumed is refused by
name; a voided month stays voided, and the correction carries a new
election. Termination ends every live enrolment in the same transaction
that applies the termination, so coverage can never outlive employment.
`,
};
