import type { DocArticle } from "../types";

export const expenseAmortization: DocArticle = {
  slug: "expense-amortization",
  title: "Expense Amortization",
  category: "accounting",
  order: 6,
  summary:
    "Defer prepaid and deferred expenses from bills, journals and expense reports, amortize them by period through schedules, and reconcile the prepaid accounts to the general ledger.",
  updated: "2026-10-11",
  keywords: [
    "amortization",
    "prepaid expense",
    "deferred expense",
    "amortization schedule",
    "amortization template",
    "prepaid insurance",
    "service period",
    "straight-line",
    "exact days",
    "waterfall",
    "reconciliation",
  ],
  related: ["revenue-recognition", "fixed-assets-depreciation"],
  body: `# Expense Amortization

Some costs are paid before the company benefits from them: a year of insurance,
an annual software subscription, a maintenance contract. Expense amortization
holds such a cost in a **deferral (prepaid) account** when it is billed and
releases it to expense over the periods it covers, one balanced journal entry
per period.

Turn it on in **Company Settings → Features → Expense amortization**. Schedules
live under **Accounting → Amortization**. Turning the feature off hides the
workspace and refuses new deferrals and runs; existing schedules and their
history are kept.

---

## Amortization templates

A template states how a cost amortizes. Templates are configured under
**Company Settings → Setup → Amortization templates**:

| Setting | Meaning |
| --- | --- |
| **Method** | **Straight-line by period** splits the amount evenly across the periods. **Prorated first and last** gives full months equal shares and partial first and last months a share in proportion to their days. **Exact days** weighs each month by the service days it contains. **Variable** follows a percentage table. |
| **Term source** | **Template periods** amortizes over the template's number of periods, starting at the line's service start (or the transaction date). **Service dates** amortizes over the line's own service start and end. |
| **Number of periods** | The term for a template-period template. A variable template has one period per percentage row. |
| **Percentage table** | Variable templates only: one percentage per period, summing to exactly 100. |
| **Period offset** | Periods to wait after the start before amortization begins. |
| **Deferral account** | The prepaid (current or other asset) account the cost is held in. |
| **Default destination** | The expense account amortization releases into. Left blank, each line amortizes into its own account. |

Amounts are split in whole currency units and any rounding remainder lands in
the last period, so the periods always add up exactly to the deferred amount.

Templates are **effective-dated by code**. A transaction uses the version of
its template in effect on its posting date. A version that a schedule or a
posted line has used keeps its policy: to change the policy, add a new version
of the same code with a later effective date. Name, description and the active
flag can still be edited.

## Deferring a bill line

On a vendor bill, choose an **Amortization template** on the line and, when the
template takes its term from service dates, enter the **Service start** and
**Service end**. Code the line to the expense account the cost belongs to.

When the bill posts, the line debits the template's deferral account instead
of its expense account, and a schedule is created for it in the same posting:
its amount is the line's posted amount (including any nonrecoverable tax) in
the entity's functional currency, and it carries the line's department,
project, location, class and segments. Journal and expense report lines take
the same fields through the documents API and post the same way.

Posting refuses, naming the line and the fix, when the feature is off, the
template has no version in effect, the service dates are missing or reversed,
the line is an inventory line or a credit, or the accounts are not a prepaid
asset and an expense account.

## Running amortization

Open **Accounting → Amortization → Run**, choose the period and run. Every
planned period of an active schedule that ends on or before the period end
posts once: debit the period's expense account, credit the deferral account,
dated the last day of its month, in the schedule's book and entity. Running
again posts nothing twice.

A period that is closed for the schedule's entity and book is skipped and
listed with its remedy; the schedule's later periods wait for it. Either reopen
the period through a reopen request, or change the schedule's remaining term so
the unposted amount moves into an open period.

To amortize without an operator run, also turn on **Automatic amortization**
under the same feature. The scheduler then posts periods as they end.

Period close includes the computed step **Amortize prepaid expenses**. It is
complete when no active schedule has an unposted period ending on or before the
period end in the close's book and entities.

## Changing a schedule

Every change is made from the schedule's **Changes** tab, needs a reason, and
is recorded in its **History** with the state before and after. Posted periods
are never rewritten; a change takes effect from a period after the last one
posted.

- **Hold** and **Resume** pause and restart amortization. A held schedule is
  skipped by runs.
- **Change term** spreads every unposted amount — including earlier periods
  that never posted, such as a closed month — evenly from a period through a
  new last period. A variable schedule follows its table and cannot change
  term.
- **Change destination** amortizes into another expense account from a period.
- **Reduce** records a credit — for example a vendor credit coded to the
  prepaid account — against the schedule. The reduction comes out of the
  unposted periods, which are re-planned from the credit's month (or the first
  month after the last posted period). When the credit exceeds what is
  still unamortized, the excess amortization returns to the deferral account in
  a catch-up entry and the schedule completes.
- **Cancel** ends the schedule. **Write off** expenses the unamortized balance
  on the cancellation date. **Reverse** returns the amortization already posted
  to the deferral account, for a source that was credited in full.

Voiding a source bill, journal or expense report cancels its schedules in the
same transaction: the void returns the deferral to the payable, and the
schedule's posted amortization returns from expense to the deferral account in
the void's period.

## Manual schedules

For a prepaid balance that already stands in the deferral account — for
example one carried in from another system — choose **New schedule**. Enter the
template, entity, deferred amount, any amount already amortized, the service
window and the first period to amortize. The schedule is saved as a draft and
posts nothing; **Activate** starts its amortization.

## Reports and reconciliation

- **Prepaid expense waterfall** (Reports) shows amortized and scheduled amounts
  by month, deferral account and currency.
- **Prepaid expense reconciliation** (Reports, and the **Reconciliation** tab
  of the workspace) sets each deferral account's general ledger balance beside
  the unamortized balance of its schedules, by book, subsidiary and currency.
  Through any date the two agree; a difference is a posting to the deferral
  account that no schedule accounts for.

## Permissions

**amortization.read** sees schedules and their reports. **amortization.manage**
runs amortization, records manual schedules and makes schedule changes; it is
also needed, with company setup access, to maintain templates.
`,
};
