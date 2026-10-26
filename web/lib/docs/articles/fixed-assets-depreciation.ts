import type { DocArticle } from "../types";

export const fixedAssetsDepreciation: DocArticle = {
  slug: "fixed-assets-depreciation",
  title: "Fixed Assets and Depreciation Evidence",
  category: "accounting",
  order: 4,
  summary:
    "Configure asset books, depreciate exactly, capitalize purchases and construction in progress, and keep compound assets, maintenance and insurance in one register.",
  updated: "2026-10-11",
  keywords: [
    "fixed assets",
    "depreciation",
    "manual depreciation",
    "units of production",
    "usage",
    "evidence",
    "asset book",
    "onboarding",
    "mid-life",
    "opening accumulated",
    "component",
    "compound asset",
    "asset proposal",
    "capitalization rule",
    "construction in progress",
    "CIP",
    "maintenance",
    "insurance",
    "roll-forward",
  ],
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

## Onboarding a mid-life asset

An asset that arrives with history from a previous system keeps its original
acquisition cost and in-service date. Record what the old system had already
depreciated in the drawer's Opening accumulated field with the date it was
measured through in Opening as of, or fill the Opening accumulated
depreciation and Opening as-of date columns on fixed-asset import. The two
figures travel together: entering one without the other is refused, and the
opening amount can never exceed cost less salvage.

Opening balances are memo figures, not journals. Nothing is posted for the
pre-cutover months and nothing is caught up: the schedule starts after the
as-of date and spreads only the remaining amount — cost, less salvage, less
opening accumulated — over the remaining life. The register's net book value
always ties out as cost, minus opening accumulated, minus posted
depreciation.

Once depreciation posts against the asset, the opening figures lock. Correct
a wrong opening figure before the first posting run.

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
environment and confirm they produce one journal per due line.

## Compound assets

Turn on **Compound assets** under Fixed Assets in **Company Settings →
Features**. An asset's **Components** tab then lists the parent and its
components. Each component is a full asset with its own category, cost, life,
method and schedule in every book, so it depreciates, is disposed, written off
or transferred on its own. The tab rolls cost, accumulated depreciation and
carrying value up per book across the family.

Components are one level deep and always belong to the parent's legal entity.
Attaching an asset to itself, to its own component, to a component, or across
legal entities is refused, and so is attaching an asset whose schedules cover
different books from the parent's. **Dispose of asset and components** disposes
the parent and every remaining live component in one transaction: each asset
posts its own disposal journal, a sale price is shared by carrying value, and a
draft component stops the whole operation until it is placed in service or
detached. Moving a component to another legal entity uses the intercompany
transfer, which leaves the receiving asset standing on its own.

## Asset proposals from purchases

Turn on **Asset proposals**, then add **Capitalization rules** under **Settings →
Company Setup → Assets**. A rule matches one account, one item or one item
category, optionally for one legal entity, with a minimum amount to capitalize
and an effective window. A rule's terms never change once saved; end it and add
a new rule to change policy from a date forward, so earlier postings keep the
rule they were proposed under.

When a vendor bill, expense report or journal posts in the primary book, every
debit line a rule matches at or above its minimum becomes one proposal in
**Fixed Assets → Asset proposals**. Proposals are keyed by their GL line, so
re-posting effects or running **Scan postings** over a date window never
duplicates them. From a proposal, create one asset, split the line into several
assets whose amounts add up exactly, add it as a component of an existing asset
or to construction in progress, or reject it with a reason. Select several
proposals to merge them into one asset. Every new asset records the bill line
that bought it and starts as a draft unless you place it in service at once.

The bill already debited the GL. Acceptance only moves that amount from the
account the bill debited (a clearing, expense or construction-in-progress
account) to the asset's cost account, in one reclassification journal posted
through the assets period lock; when the bill already debited the asset account
nothing posts. While an acceptance stands, the asset's cost, category, account
and legal entity are fixed. **Reverse acceptance** posts the mirror journal,
removes the draft assets it created and returns the proposals to the queue.
Voiding or reversing the source bill is refused while an accepted proposal
depends on it; pending proposals on a reversed bill are voided.

## Construction in progress

Turn on **Construction in progress** and open a record in **Fixed Assets →
Construction in progress** on a fixed or other noncurrent asset account used
for construction. A record never depreciates. Its cost is the GL lines you link
to it — bills, journals, expense reports and project costs posted to that
account in its legal entity — each line feeding at most one record. A proposal
accepted into the record links its reclassification line automatically.

**Capitalize** moves part or all of the open balance into new assets or
components, placed in service on the capitalization date when asked, and
expenses whatever is not capitalizable. One journal debits each new asset's cost
account or the expense account and credits the construction-in-progress account.
Only cost posted on or before the capitalization date can be capitalized on that
date, never more than the open balance. A capitalization that empties the record
closes it; reversing the latest capitalization posts its mirror, removes the
draft assets it created and reopens the record.

The **Reconciliation** view compares, per legal entity and account, the
subledger (linked cost less capitalizations up to a date) with the account's
primary-book balance. A difference is GL activity on the account no record has
linked yet. A linked source cannot be voided until its cost is unlinked, and a
cost already capitalized cannot be unlinked until that capitalization is
reversed.

## Maintenance

**Asset maintenance** schedules recur every few months, every so many meter
units (hours, kilometres, cycles), or both — whichever comes first. The next due
point counts from the last work recorded, or from the schedule's start. The
queue shows each schedule as scheduled, due within its notice days, or overdue,
and notifies users who hold the maintenance duty once per due point.

Record work against a schedule with its date, meter reading, vendor, cost and
the vendor bill line that paid for it. Meter readings never run backwards.
Routine work is an expense and posts nothing. A **betterment** is capitalized
from its bill line through Asset proposals, where it is added to the asset as a
component. Cancelling a record restores the schedule's previous due point.

## Insurance

**Asset insurance** records policies with their insurer, policy number,
coverage period, premium, deductible and renewal notice, each covering assets of
one legal entity at an insured and optional replacement value. Renewal reminders
go out at the policy's notice period, one week before and on the expiry day, and
stop once a renewal is recorded. **Renew** creates the next period and carries
the covered assets over. The insured-value view compares each covered asset with
its primary-book net book value. Insurance records post nothing.

## Reports

The **Fixed assets** group in Reports holds the register by book (with status,
parent and construction in progress), the cost and depreciation roll-forwards
by book (opening, additions, transfers and partial disposals, disposals,
construction capitalized, depreciation, remeasurement and closing), the
depreciation forecast of unposted schedule lines, pending proposals, maintenance
due, insured value against net book value, and construction-in-progress costs.`,
};
