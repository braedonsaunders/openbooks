import type { DocArticle } from "../types";

export const compensationAndTransparency: DocArticle = {
  slug: "compensation-transparency",
  title: "Compensation and pay transparency",
  category: "projects",
  order: 10,
  summary:
    "How job architecture, pay bands, merit cycles, headcount plans, and pay-equity snapshots work — what a role should pay, how a raise is decided and pushed, and how gaps are measured from payroll truth.",
  updated: "2026-09-20",
  keywords: [
    "compensation",
    "pay bands",
    "compa-ratio",
    "merit cycle",
    "headcount plan",
    "pay equity",
    "pay transparency",
    "guideline",
  ],
  related: ["positionsAndHeadcount", "performanceAndRetention", "recruitingFunnel", "payroll"],
  body: `# Compensation and pay transparency

Positions carry planned and funded FTE and payroll carries what is paid.
Compensation is the layer between them: what a role SHOULD pay, whether
a person sits in range, how a raise is decided, and whether pay is
equitable across the org's declared comparison groups.

Job architecture is the org's own ladder: families (crafts like
Engineering) with levels (rungs like IC3), or one org-wide ladder for
small orgs. Each level declares the gender-neutral equal-value criteria
(skills, effort, responsibility, working conditions) with weights — the
directive requires the criteria to be declared, never implied. A level
never moves ladders: retire it and recreate on the right one.

Pay bands are versioned SHOULD-pay rows (min/target/max) scoped to a
level, narrowed by family, employer subsidiary, and location. A band
change is a new row, never an overwrite of a row a cycle cited — the
overlap exclusion arbitrates races. Bands are never what anyone IS
paid: the placement read divides the payroll-side effective wage by the
band target at the as-of date. No band covering the scope reads as "no
band", never zero.

A merit cycle snapshots one line per in-service employment at open: the
payroll-side wage (read through the wage rate service, never typed),
the covering band, the stored compa-ratio, and the resolved guideline
range. Proposals come from the employment's manager or HR; outside the
guideline is allowed but flagged with a reason, never silently
accepted. Over-budget pacing warns and needs a reason, never blocks.
The round's approval is a Flows run; per-line approve/reject needs the
approval grant with the decider distinct from the proposer. Push writes
each approved line once through the canonical wage writer, effective on
the cycle's date, with the line-to-rate link making re-push a skip. A
push effective in a period payroll already ran surfaces as a retro
candidate through the existing detection — never a silent backdate.

Headcount plan lines are costed at save from the band target (or the
incumbent rate) plus the org's burden rate, with every input stored
beside the figure so it is explainable. Approving a create or backfill
line opens a requisition through recruiting; a hire against it marks
the line filled. Terminate lines are informational and never end an
employment.

Pay-equity snapshots compute the Article 9 metrics from payroll truth
(effective rates, never bands), grouped by level, between the two
org-declared comparison groups — a party custom field, never a
hardcoded attribute. The unexplained gap comes from ordinary least
squares on tenure, rank, hours, and subsidiary; categories at or above
the declared threshold flag joint assessment due. Snapshots are frozen
rows. A worker may request their own category averages; fulfilment
answers from the latest snapshot covering their category and refuses
when none does.
`,
};
