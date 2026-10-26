import type { DocArticle } from "../types";

export const batchBillEntry: DocArticle = {
  slug: "batch-bill-entry",
  title: "Entering many bills at once",
  category: "transactions",
  order: 3,
  summary:
    "Key a stack of vendor bills on one keyboard-driven grid, prove it against control totals, and save or post every bill together.",
  updated: "2026-10-21",
  keywords: [
    "batch",
    "batch entry",
    "vendor bill",
    "bills",
    "control total",
    "paste",
    "spreadsheet",
    "duplicate",
    "keyboard",
    "accounts payable",
    "data entry",
  ],
  related: ["purchasing-workflow", "transaction-lifecycle", "payments-and-applications"],
  body: `# Entering many bills at once

**Batch bill entry** puts one vendor bill on each row of a single grid, so a
stack of paper or emailed bills can be keyed without opening a form for each
one. Open it from **Bills** with **New bill** then **Batch entry**. It needs
the same permission as creating a bill; **Post all** appears only for people
who may also post bills.

Each row becomes an ordinary vendor bill with one line: the vendor, the
vendor's invoice number (**Vendor ref #**), the bill date, an optional due
date, the expense account, a memo, the amount and, when your company uses
tax codes, the tax code. The memo is used as both the bill memo and the line
description. Bills that need several lines, items or project details are
still entered one at a time in the bill form.

## Keys

The grid is built for entry without the mouse.

| Key | What it does |
| --- | --- |
| Enter or Tab | Move to the next field of the bill |
| Tab on the last field | Start the next bill |
| Up and Down arrows | Move to the same field on the bill above or below |
| F8 | Copy the field from the bill above |
| Alt+Enter | Insert a bill below |
| Ctrl+D (Cmd+D) | Duplicate the bill as a new bill |
| Ctrl+Backspace (Cmd+Backspace) | Remove the bill from the batch |
| Ctrl+S (Cmd+S) | Save all as drafts |
| Ctrl+Enter (Cmd+Enter) | Post all |

A new row takes the bill date of the row above it, so a day's bills share a
date without retyping it. Amount fields accept arithmetic such as 200+47.83,
and the auto decimal preference applies here too.

Choosing a vendor fills the account and tax code from the vendor's defaults,
or from the account the vendor's recent bills used. An account you chose
yourself is never replaced. Leave the due date blank to use the vendor's
payment terms; the empty due date shows the date the terms will give. You can
create a vendor from the vendor picker by typing its name, if you may manage
vendors.

## Pasting from a spreadsheet

Copy a block of rows from Excel or Google Sheets and paste it into the grid.
Values land from the field you paste into, column by column. If the first
copied row names the columns (Vendor, Vendor ref #, Bill date, Amount and so
on), columns are matched by name in any order. Vendors and accounts match by
name, short code or account number. A value that matches nothing is marked in
red on its field so you can correct it before saving.

## Control totals

Before keying, count the bills in the stack and add up their totals. Enter
those figures as **Number of bills** and **Batch total**. As you type, the
grid shows how many bills you have entered and their total, including tax,
and whether each control matches. A mismatch shows in red with the
difference; a match shows in green.

When a control total is set and does not match, **Save all as drafts** and
**Post all** refuse and name the difference, so a skipped or doubled bill is
found before anything is saved. Leave both fields blank to work without
control totals. **Clear finished rows** removes saved bills from the grid
and reduces the control totals by the bills removed, so the rest of the batch
keeps balancing.

## Duplicate bills

A row is marked **Possible duplicate** when another row in the batch, or a
bill already on file, has the same vendor and the same vendor invoice number.
Invoice numbers are compared without case, spaces or punctuation, so
INV-0042 and inv 0042 are the same invoice. Voided bills never match.

Saving a marked row asks for confirmation and lists every marked row. Cancel
is the default choice, so pressing Enter by reflex never saves a duplicate.

## Saving and posting

Every row is checked before anything is saved: each bill needs a vendor, a
bill date, an account and a positive amount. A negative bill is a vendor
credit and is entered as one.

Bills save one row at a time, a few at once, with a progress count. Each bill
is created through the same command as the bill form, with the same
validation, numbering and audit history. A bill that is refused shows the
reason in its **Status** column and the rest of the batch carries on. Correct
the row and save again.

Saved rows become read-only and show their bill number, which opens the bill
in a new tab. A retry never creates a second bill: each row keeps its own
create key until its bill exists, so a save interrupted by a lost connection
completes the original bill instead of adding another.

**Post all** submits each bill and then posts it, exactly as **Save and
post** does in the bill form. When your approval workflow requires approval
for a bill, it stops at **Awaiting approval** and is posted only after it is
approved; batch entry never posts around an approval. If posting is refused
(for example, because the period is closed), the bill stays saved as a draft
with the reason shown, and posting again resumes from the saved bill.

## Unsaved work

The batch is kept in your browser as you type, together with its control
totals. If you close the tab or lose power, reopening batch entry restores the
unsaved bills and offers to discard them. The copy is cleared once every bill
is saved, and leaving the page with unsaved bills asks for confirmation.
`,
};
