import type { DocArticle } from "../types";

export const revenueRecognition: DocArticle = {
  slug: "revenue-recognition",
  title: "Revenue Recognition",
  category: "accounting",
  order: 5,
  summary:
    "Recognition rules, fair value prices, relative-SSP allocation, and the fair value range policy behind ASC 606 / IFRS 15 revenue.",
  updated: "2026-07-19",
  keywords: [
    "revenue recognition",
    "ASC 606",
    "IFRS 15",
    "recognition rule",
    "performance obligation",
    "revenue contract",
    "fair value price",
    "standalone selling price",
    "SSP",
    "allocation",
    "fair value range",
    "deferred revenue",
    "percent complete",
    "project revenue",
    "unbilled receivable",
    "contract asset",
  ],
  body: `# Revenue Recognition

OpenBooks recognizes revenue the ASC 606 / IFRS 15 way: when a customer invoice
posts, each line whose item carries a **recognition rule** becomes a
**performance obligation** on a **revenue contract**. The invoice parks the
line's revenue in the item's deferred account; the recognition run then drains
deferred revenue into earned revenue period by period, one balanced journal per
schedule line.

You monitor contracts, obligations, and schedules under **Accounting → Revenue**, and
post due periods with **Run recognition**.

---

## Recognition rules

A recognition rule defines how an obligation's amount spreads over its term:
the method (**point in time**, **straight-line** variants, **percent complete**,
**milestone**, **usage**), the start and end date sources, offsets, an optional
up-front percentage, and the deferred/recognized accounts. Rules are configured
under **Settings → Company Setup → Recognition Rules** and
attached to items.

## Fair value prices and allocation

When one invoice bundles several rev-rec lines, the transaction price is
allocated across the obligations in proportion to each item's **standalone
selling price** (the relative-SSP method). The SSP for a line resolves in this
order:

1. The item's own standalone selling price, when set.
2. A dated **fair value price** for the item — the list you maintain under
   **Settings → Company Setup → Fair Value Prices**. Entries
   are scoped by currency and effective dates, so the price in force on the
   invoice date wins.
3. The booked line amount, as the fallback weight.

## Fair value range checking

A fair value price can also carry a **Low value** and **High value** — the
acceptable range for allocation review. After allocation, OpenBooks compares
each obligation's **allocated per-unit price** (the allocated amount divided by
the line quantity) against the matched range:

- Inside the range, or no bounds configured: nothing happens.
- Outside the range: the obligation is flagged **below range** or **above
  range**, and its revenue contract shows a warning badge with the expected
  range on the obligation.

The check is a review aid, never a posting block — the invoice and the
recognition schedules post normally either way.

The policy is configurable under **Settings → Company Setup →
Company & Accounting**, in the **Revenue recognition** card:

- **Warn** (default) — flag out-of-range allocations for review.
- **Off** — no range checking.

## Fixed-price project revenue (percent complete)

A fixed-price project — any project whose project type's recognition policy is
**percent_complete_cost** and that carries a contract value and customer —
gets its own revenue contract with a single **percent-complete** obligation,
visible on the Revenue page like every other contract. The project record
carries progress data only:

- **Percent complete** defaults to cost-to-cost: posted project cost divided by
  the task budget.
- A **percent complete override** on the project's Financials tab lets a
  manager enter the estimate directly (blank returns to automatic). Saving the
  override updates the plan — it never posts.

A change in percent complete is a change in estimate: the cumulative catch-up
(up **or down** — a falling estimate reverses revenue) is planned into the
current period and posted by the next central recognition run, never restated
into past periods.

**Account treatment.** Project recognition follows the percentage-of-completion
contract-asset model: the run posts **debit Unbilled receivable / credit
Project revenue** (both mapped in Company & Accounting control accounts), and
the project invoice relieves Unbilled receivable — revenue is earned over time,
billed later, and never double-counted. The feature is inert until both control
accounts are mapped.

## Running recognition

**Run recognition** posts every due, unposted schedule line up to the as-of
date: one journal per line, debit deferred revenue (or Unbilled receivable for
project contracts), credit recognized revenue. The run first refreshes every
project contract's percent complete, so project catch-ups post in the same
pass. Closed periods are skipped and reported, never forced. Re-running is
safe — a posted line is never posted twice.
`,
};
