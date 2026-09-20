import type { DocArticle } from "../types";

export const leaveTimeVersusValue: DocArticle = {
  slug: "leave-time-versus-value",
  title: "Leave: time versus value",
  category: "projects",
  order: 8,
  summary:
    "Why leave balances come in two units — time in HR and value in payroll — how they connect through the pay-run input queue, and what happens when a request changes after calculation.",
  updated: "2026-09-20",
  keywords: [
    "leave",
    "vacation",
    "absence",
    "time balance",
    "payroll bank",
    "pay run input",
    "payout",
    "bank in lieu",
    "retro",
  ],
  related: ["payroll", "employment-migration"],
  body: `# Leave: time versus value

A leave balance answers two different questions, and the app keeps the two
answers in two different places on purpose. "How much time off do I still
have?" is answered in TIME, in hours, by the HR leave policy: the accrual
rule minus approved absences, plus carryover. "How much is banked for me in
money?" is answered in VALUE by the payroll entitlement bank, computed by
the pay run. Time is the policy; value is the ledger. They are never the
same number, and no screen adds them together.

The policy is HR's entitlement in time. A leave type (vacation, sick,
unpaid) declares which of the two allowed pay-run movements it raises, if
any: none, payout, or bank_in. A leave policy declares the accrual rule —
none, per period, per year, or unlimited — the carryover rule, the minimum
notice, and the effective window. The request drawer shows the time balance
labelled as time, and where a payroll bank exists it shows the bank balance
labelled as value, each with its unit. An unlimited policy has no balance
number at all: unbounded is not zero.

Only two things cross from HR to payroll, and they cross as pay-run inputs,
never as ledger writes. When a request for a payout or bank_in type is
approved, HR writes one input row per absence day — hours only, no amount —
and the pay run reads those rows when it computes, resolving the rate
itself. An absence that is unpaid or paid from salary never touches the
ledger; there is no "taken" movement and none will be added. Recorded
after-the-fact absences likewise raise no inputs: value treatment for a
backdated day goes through a leave request or a retro run.

Timing is where the seam bites. Approving a day a committed pay run already
covers is refused: paid history is never rewritten from HR, and the remedy
is a retro run owned by payroll. Days covered by a calculated-but-uncommitted
run are written pending, and the commit gate refuses while any pending row
remains for the period. Cancelling a request after calculation voids its
inputs but keeps the link to the run, so the gate can still see the stale
calculation and demand a recalculate — release-then-reconsume drops the
voided days. Cancelling a request a committed run already consumed is
refused with the same retro remedy: a paid row is never flipped to voided.

Corrections follow the same evidence rule as everything else in HR:
approvals write the absence record per day, cancellations reverse it with
negative-hours rows, and nothing is ever updated or deleted in place. A
fully reversed day reads zero hours, never vanishes. If a voided input
still names a run, that is the run whose calculation went stale —
recalculate it, and the queue goes quiet.
`,
};
