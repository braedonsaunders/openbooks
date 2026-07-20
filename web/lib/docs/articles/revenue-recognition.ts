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
  ],
  body: `# Revenue Recognition

OpenBooks recognizes revenue the ASC 606 / IFRS 15 way: when a customer invoice
posts, each line whose item carries a **recognition rule** becomes a
**performance obligation** on a **revenue contract**. The invoice parks the
line's revenue in the item's deferred account; the recognition run then drains
deferred revenue into earned revenue period by period, one balanced journal per
schedule line.

You monitor contracts, obligations, and schedules under **Sales → Revenue**, and
post due periods with **Run recognition**.

---

## Recognition rules

A recognition rule defines how an obligation's amount spreads over its term:
the method (**point in time**, **straight-line** variants, **percent complete**,
**milestone**, **usage**), the start and end date sources, offsets, an optional
up-front percentage, and the deferred/recognized accounts. Rules are configured
under **Administration → Company Settings → Setup → Recognition Rules** and
attached to items.

## Fair value prices and allocation

When one invoice bundles several rev-rec lines, the transaction price is
allocated across the obligations in proportion to each item's **standalone
selling price** (the relative-SSP method). The SSP for a line resolves in this
order:

1. The item's own standalone selling price, when set.
2. A dated **fair value price** for the item — the list you maintain under
   **Administration → Company Settings → Setup → Fair Value Prices**. Entries
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

The policy is configurable under **Administration → Company Settings → Setup →
Company & Accounting**, in the **Revenue recognition** card:

- **Warn** (default) — flag out-of-range allocations for review.
- **Off** — no range checking.

## Running recognition

**Run recognition** posts every due, unposted schedule line up to the as-of
date: one journal per line, debit deferred revenue, credit recognized revenue.
Closed periods are skipped and reported, never forced. Re-running is safe — a
posted line is never posted twice.
`,
};
