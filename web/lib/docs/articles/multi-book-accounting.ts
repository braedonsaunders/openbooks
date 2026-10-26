import type { DocArticle } from "../types";

export const multiBookAccounting: DocArticle = {
  slug: "multi-book-accounting",
  title: "Multi-Book Accounting",
  category: "accounting",
  order: 7,
  summary:
    "Keep secondary accounting books in their own currency per subsidiary, map accounts per book, replicate every transaction into full books, post book-specific journals and compare books.",
  updated: "2026-10-11",
  keywords: [
    "multi-book",
    "secondary book",
    "accounting book",
    "replication",
    "book-specific journal",
    "IFRS",
    "GAAP",
    "tax book",
    "book currency",
    "account mapping",
  ],
  related: ["allocations", "period-close", "fixed-assets-depreciation"],
  body: `# Multi-Book Accounting

Every journal entry belongs to exactly one accounting book. The **primary
book** is the chart of record: documents post there. A **secondary book**
(a tax book, a second GAAP, a statutory book) is a parallel measurement of
the same business. Turn the module on under Company Settings → Features →
**Multi-book accounting**; the setup pages below then appear under Setup →
Accounting.

Without the module, secondary books already receive the entries their own
engines post: depreciation on their own schedules, revenue recognition on
their own schedules, allocation contributions, FX revaluation and asset
changes. Multi-book accounting adds a book currency per subsidiary,
account mappings, full replication of ordinary transactions, book-specific
journals and the Book Differences report.

## Book currencies

A secondary book can carry a subsidiary in its own base currency — for
example a US GAAP book in USD for a subsidiary whose functional currency is
GBP. Add a version under Setup → **Book currencies**: the book, the
subsidiary, the currency, the rate type and the date it applies from.

- **Spot** translates at the newest spot rate on or before the posting date;
  **Monthly average** uses the mean of the calendar month's spot rates.
  Rates come from Setup → Exchange rates, and a missing rate refuses the
  posting with the pair and date to record. Nothing falls back to 1.
- Once a book carries a subsidiary in a currency, every posting into that
  book for that subsidiary must fall inside a version's dates; a posting
  dated outside them refuses.
- A version never changes under entries the book already holds: its
  currency, rate type and start date are fixed, and its window cannot end
  before its latest entry. To change the rate type, add a version from a
  date after the book's latest entry for that subsidiary. A book keeps one
  currency per subsidiary; a different currency needs a new book.
- The primary book always carries each subsidiary in its functional
  currency.

### How translation works

Each line translates from its own transaction currency at the book's rate:
book amount = transaction amount × rate, rounded half away from zero to the
ledger's four decimals, in exact decimal arithmetic. The line keeps its
transaction currency, so the book's own FX revaluation measures foreign
balances against the book currency.

Each subsidiary's lines must still balance on their own:

- When all of a subsidiary's lines share one transaction currency, any
  difference is per-line rounding and is absorbed onto its largest line
  that is not a tax or open-item leg — the same rule the posting kernel
  applies to functional rounding.
- Any other difference is a genuine currency difference between the
  transaction currencies of the posting. It posts as one book-currency line
  to the book's **currency difference account** (an income, expense or
  equity account set under Book replication). A book without that account
  refuses the posting.

Every posting into a book — replicated documents and generated entries
alike (depreciation, recognition, allocations) — follows these rules. The
book's FX revaluation already measures in the book currency, so its entries
pass through unchanged.

## Account mappings

Setup → **Book account mappings** carries a chart account as another
account in one book, from a date and optionally for one subsidiary (a
subsidiary mapping wins over an organization-wide one). Mappings apply to
every entry replicated or generated into the book. A mapping is refused
when the book account:

- belongs to another statement class (asset, liability, equity, income or
  expense),
- carries a currency restriction the chart account does not share,
- is not available to a subsidiary the mapping covers, or
- is inactive or a summary account.

The same checks run again whenever a mapping is applied, so an account
changed after configuration cannot slip through. A mapping never changes
under book entries it governed: it cannot start before an entry the book
holds on the chart account, and its window cannot end before its latest
entry. Book-specific journals are not mapped — they name the book's
accounts directly.

## Replication modes

Each secondary book is either **Adjustment only** (it receives only
book-specific journals and the entries its own engines generate) or
**Full** (it also receives every replicable primary posting).

A full book receives each primary posting in the same database transaction
as the posting itself, carried through its mappings and translated into its
currency. Replication is exactly-once — one record per book and source
entry — and never edits posted history:

- A reversal replicates as a reversal of the book's copy, and marking a
  primary entry reversed marks its copies reversed.
- Each book's own period locks apply to its copy. A closed period in a full
  book refuses the primary posting until that book's period is reopened.
- Copies of receivable and payable legs are ledger balances in the book;
  open items and their applications live in the primary book's subledgers.

What replicates: every primary-book entry except the entries each book
measures for itself (depreciation, disposals and asset revaluation, revenue
recognition, allocations, FX revaluation, consolidation translation,
provisions, year-end closing and book openings), book-specific journals,
and reversals of those. Realized FX settlement entries replicate for the
subsidiaries a book carries in their functional currency; for a subsidiary
the book translates, its settlement lines are left out because the book
measures its own currency differences through its FX revaluation. Assets
and revenue arrangements therefore need schedules in each full book.

## Activating full replication

Activate from Setup → **Book replication** with a new record: the book, the
date replication starts, how earlier history enters the book, and a reason.

| Earlier history | What happens |
|---|---|
| **Opening balances** | One opening entry per subsidiary, dated on the start date, carries each account's balance (by transaction currency) from replicable primary entries before that date. Balances in the book currency carry their amount; foreign balances restate at the rate the book uses on the start date. Whatever does not balance after restatement posts to the currency difference account. |
| **Full history** | Every replicable primary entry replicates. Refused while the primary book holds replicable entries dated before the start date. |

Either way the book then receives every replicable primary entry dated on
or after the start date, in posting order, in the same step. The whole
activation commits or refuses together — a closed book period, a missing
rate or an incompatible mapping names its remedy and nothing is half done.
The start date is fixed once set.

Other changes on the same page: **Deactivate** stops replication (the book
keeps what it received); activating again resumes from the fixed start date
and catches up every entry it missed; **Catch up** fills any gap in a full
book; **Change settings** sets the currency difference account. Each change
is recorded with its actor, reason and outcome, and the book's before and
after state is in the audit log.

The module cannot be switched off while a book replicates in full —
deactivate replication first.

## Book-specific journals

A manual journal can target one book. In the journal drawer, **Accounting
book** offers **All books** (the standard journal: it posts to the primary
book and replicates into every full book) or a specific book, including the
primary book alone. A book-specific journal posts to that book only, in the
currency the book keeps for the journal's subsidiary. Choosing a book needs
the **Post book-specific journals** permission, and the poster must hold it
too. The journal list shows each entry's book and filters by book code.

## Close and reports

Period close carries the step **Confirm full books are complete**. It
counts replicable primary entries through period end that a full book does
not hold; for the primary book's close it checks every full book. Record a
catch-up to clear it.

Every financial statement, trial balance, general ledger and journal report
has a book selector. A secondary book's statements present each subsidiary
in the book's currency for it and are labelled with that currency; a
consolidated view translates from the book currencies. **Book Differences**
(Reports → Financial statements) shows each account's balance in the
primary book beside a secondary book as of a date, with the difference.
When the two books state the view in different currencies, both balances
show with their currency and no difference is computed.
`,
};
