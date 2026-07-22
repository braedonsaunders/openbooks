import type { DocArticle } from '../types'

export const fixedAssetsDepreciation: DocArticle = {
  slug: 'fixed-assets-depreciation',
  title: 'Fixed Assets and Depreciation Evidence',
  category: 'accounting',
  order: 4,
  summary: 'Configure asset books and record exact, auditable formula, manual, and units-of-production depreciation.',
  updated: '2026-07-21',
  keywords: ['fixed assets', 'depreciation', 'manual depreciation', 'units of production', 'usage', 'evidence', 'asset book'],
  body: `# Fixed Assets and Depreciation Evidence

The fixed-asset register separates the asset record, each accounting book's
depreciation schedule, the accountant input supporting a period, and the posted
journal. This keeps a manual amount or production reading from becoming an
unexplained edit to a future schedule.

Configure category defaults under **Settings → Company Setup → Assets → Asset
categories**. Per-book category overrides are under **Depreciation book
policies**. An asset may override method, life, rate, convention, and expected
lifetime units in its drawer. A null asset override inherits the applicable
book policy and then the category default.

## Formula methods

**Straight-line**, **declining balance**, and **double declining balance** build
period plans when the asset is saved. Calculations use exact decimal arithmetic,
round once to ledger precision, and cap the final charge at salvage value.
Changing an unposted formula configuration rebuilds only unposted formula lines;
posted history is never rewritten.

## Manual depreciation

Choose **Manual**, place the asset in service, and select **Record manual
depreciation** from the asset actions. Enter:

- the effective date, which resolves to a non-adjustment accounting period;
- the exact depreciation amount;
- an accounting memo; and
- an evidence reference such as an approved calculation or file-cabinet record.

The cumulative amount cannot reduce net book value below salvage or below zero
accumulated depreciation. Saving a new amount for the same unposted period voids
and supersedes the prior input while preserving it for audit. A posted input
cannot be changed or deleted. Correct it with a separately evidenced negative
amount in an open period; the correcting journal reverses expense and accumulated
depreciation without rewriting the original evidence or ledger entry.

## Units of production

Choose **Units of production** and set **Expected lifetime units** before placing
the asset in service. For each period, select **Record production usage** and
enter the period units, memo, and meter-reading, work-order, or file reference.

The charge is:

~~~
(acquisition cost - salvage value) × period units ÷ expected lifetime units
~~~

OpenBooks performs the ratio with exact fixed-point arithmetic. Cumulative usage
cannot exceed expected lifetime units, and cumulative depreciation cannot cross
the salvage floor. A separately evidenced negative usage entry corrects an
overstated posted meter reading without editing it; cumulative usage and
depreciation may never fall below zero. No future production is guessed: a
schedule line exists only after its period evidence is recorded.

## Posting and control behavior

**Run depreciation** claims each due schedule line under a database row lock,
rechecks both the Assets and GL period locks, independently proves the journal is
balanced, posts debit depreciation expense and credit accumulated depreciation,
and links the journal to the line in one transaction. Concurrent runs cannot post
the same line twice. The database independently enforces evidence provenance and
immutability.

Before cutover, reconcile acquisition cost, salvage, accumulated depreciation,
net book value, remaining life or units, and at least one evidence-backed period
for every active book. Run competing depreciation jobs in the parallel-books
environment and confirm they produce one journal per due line.`,
}
