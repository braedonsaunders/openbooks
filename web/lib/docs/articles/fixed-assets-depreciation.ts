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
journal. Manual amounts and production readings are retained as explicit
evidence rather than applied as unexplained changes to future schedules.

Configure category defaults under **Settings → Company Setup → Assets → Asset
categories**. Create reusable formulas under **Settings → Company Setup →
Depreciation → Depreciation methods**, and configure category-specific book
rules under **Depreciation book policies**. An asset may override its formula or
built-in method, life, rate, convention, expected lifetime units, and three GL
accounts in its drawer. Account overrides are typed, tenant-scoped references to
active postable accounts; they are not stored as unvalidated custom data.

Each active accounting book has an independent schedule. A policy for the book
and category can select a formula and its own life or convention. Formula
selection follows **book policy → asset → category**, while the remaining
settings use the corresponding configured fallback. A **posts GL** book creates
journals; a reporting-only book calculates and retains its schedule without
leaking entries into the general ledger. The primary book alone controls the
asset's accumulated-depreciation and net-book-value summary.

## Formula methods

**Straight-line**, **declining balance**, and **double declining balance** build
period plans when the asset is saved. A configured depreciation formula appears
in the same method selector and is snapshotted onto each schedule that uses it.
Snapshotting applies the formula to schedule calculations and preserves the
definition used by each schedule. Formula
definitions are validated before they can be saved. Use these variables:

- **OC** original cost, **CC** current cost, **NB** opening net book value, and
  **RV** residual value;
- **AL** asset life, **CP** current period, **TD** total depreciation, and **LD**
  last-period depreciation;
- **CU** current usage, **LU** lifetime usage, **DH** days held, **DP** days in
  the period, **FY** first-year fraction, and **PB** period beginning balance;
- **R1**, **R2**, and later numbered rates when a rate table is supplied.

Formulas support arithmetic, integer powers, comparisons, **ROUND**, conditional
**IF … THEN … ELSE … ENDIF**, and **~** to select the greater result. Once a
formula has materialized any schedule, its calculation and end-of-life rule are
immutable. Create a new method version for a changed calculation so historical
schedule evidence always resolves to the exact definition that produced it.

Calculations use exact decimal arithmetic, round to ledger precision, and cap
the final charge at salvage value. Changing an unposted formula configuration
rebuilds only unposted formula lines; posted history and its formula snapshot are
never rewritten.

## Manual depreciation

Choose **Manual**, place the asset in service, attach the approved calculation
on the asset's **Files** tab, and select **Record manual depreciation** for the
intended book from the asset actions. Enter:

- the effective date, which resolves to a non-adjustment accounting period;
- the exact depreciation amount;
- an accounting memo; and
- the attached evidence file.

The cumulative amount cannot reduce net book value below salvage or below zero
accumulated depreciation. The database proves that the selected file is active,
belongs to the same tenant, and is attached to the owning asset. Once referenced,
that attachment cannot be detached. Saving a new amount for the same unposted
period voids and supersedes the prior input while preserving it for audit. A
posted input cannot be changed or deleted. Correct it with a separately
evidenced negative amount in an open period; the correcting journal reverses
expense and accumulated depreciation without rewriting the original evidence or
ledger entry.

## Units of production

Choose **Units of production** and set **Expected lifetime units** before placing
the asset in service. For each period and book, select **Record production
usage** and enter the period units, memo, and an attached meter-reading or
work-order file.

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
the same line twice. Use the book selector when more than one posting book is
active. Reporting-only books remain explicitly non-posting.

The schedule tab is server-paginated and can be searched or filtered by book.
Each row identifies its book, source, posted journal, and evidence file. Evidence
downloads honor both file visibility and the user's subsidiary access to the
owning asset. The database independently enforces evidence provenance,
cross-tenant isolation, attachment retention, and posted-input immutability.

Before cutover, reconcile acquisition cost, salvage, accumulated depreciation,
net book value, remaining life or units, and at least one evidence-backed period
for every active book. Run competing depreciation jobs in the parallel-books
environment and confirm they produce one journal per due line.`,
}
