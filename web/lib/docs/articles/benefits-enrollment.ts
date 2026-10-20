import type { DocArticle } from "../types";

export const benefitsEnrollment: DocArticle = {
  slug: "benefits-enrollment",
  title: "Benefits: offers, contribution elections and payroll",
  category: "projects",
  order: 9,
  summary:
    "Configure effective-dated benefit offers and contribution rules, record employee elections, submit them through Flows, and retain exact payroll allocation evidence.",
  updated: "2026-10-20",
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
  body: `# Benefits: offers, contribution elections and payroll

A benefit offer names what an employer provides, its provider, currency,
waiting period and effective dates. Configure offers and their contribution
rules in Benefits. Kinds such as health, dental and retirement are declared
by the organization.

## Contribution rules and elections

Effective-dated contribution rules define employee deductions, employer
contributions, taxable non-cash benefits or earnings. Each rule declares its
native payroll component, exact rate, eligible hours or cash-pay basis,
partial-period treatment and other required policy. Tax treatment, remittance
and accounting follow that payroll component.

Supported bases include per hour, per pay period, per month, per year and a
percentage of eligible pay. Monthly and annual bases are evaluated under the
rule’s declared annualization policy. Missing rates, required eligibility or
component configuration refuse explicitly.

An employee election names the offer, coverage dates, class, dependents and
contribution terms. Each contribution term either fixes an elected rate or
follows its effective-dated policy. Those choices are recorded explicitly;
a policy-following term cannot also supply a fixed rate.

## Submit through Flows

Submit the election through its native record action. The tenant configures
conditions, assignees, quorum and self-approval in Flows. Zero applicable gates
activate eligible coverage immediately. Otherwise every governing gate must
complete. Submission and decision evidence retain the actual coverage terms,
actor and policy. A waiver records an explicit decline.

Changed coverage uses a successor election with its own effective date and
Flow submission. Prior coverage and consumed payroll evidence remain retained.
Ending or withdrawing coverage follows its native lifecycle and refuses changes
that would rewrite consumed obligations.

## Payroll allocations

Payroll calculates contributions from the approved coverage, contribution
terms, dated policy, eligible work and pay-period facts. Calculation retains the
specific rule and election evidence behind each amount. Commit consumes the
native allocations with the payroll transaction; replay does not create a
second obligation. Corrections use the governed payroll and coverage lifecycle.

Currency and exact decimal rates are explicit. A later policy revision cannot
reinterpret a committed payroll allocation, and payroll never silently prices
missing configuration as zero.
`,
};
