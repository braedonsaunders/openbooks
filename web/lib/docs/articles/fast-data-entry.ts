import type { DocArticle } from "../types";

export const fastDataEntry: DocArticle = {
  slug: "fast-data-entry",
  title: "Fast data entry from the keyboard",
  category: "transactions",
  order: 2,
  summary:
    "Enter bills, invoices and journals without the mouse: type-to-search pickers, vendor defaults and recall, Post & new, line-grid keys, spreadsheet paste, arithmetic in amounts and personal entry preferences.",
  updated: "2026-10-21",
  keywords: [
    "keyboard",
    "shortcuts",
    "data entry",
    "fast entry",
    "save and new",
    "post and new",
    "recall",
    "last bill",
    "control total",
    "paste",
    "calculator",
    "auto decimal",
    "enter key",
    "duplicate",
    "command palette",
  ],
  related: ["batch-bill-entry", "transaction-lifecycle", "purchasing-workflow"],
  body: `# Fast data entry from the keyboard

Everything you enter day to day — bills, invoices, credits and journal
entries — can be keyed from start to finish without reaching for the mouse.
Press **?** anywhere to see the keys available where you are.

## A bill in a few keystrokes

1. **Ctrl+Alt+B** (⌃⌥B on a Mac) opens a new bill with the cursor already in
   **Vendor**. **Ctrl+Alt+I** does the same for an invoice and **Ctrl+Alt+J**
   for a journal entry.
2. Type part of the vendor's name or its short code — **sta**, **CONED** — and
   press **Enter**. The best match is chosen and the cursor moves on.
   Vendors you use often are listed first.
3. The line is already coded with the vendor's default account, or with the
   account the vendor's recent bills used. A note under the lines says which.
4. Type the date (**1015** is October 15; **t** is today, **+** and **-** move a
   day), the vendor's invoice number, and the amount.
5. **Ctrl+Enter** (⌘↵) saves and posts the bill and opens the next one with
   the same date. **Ctrl+Alt+S** saves it as a draft and opens the next one;
   **Ctrl+S** (⌘S) saves the draft and stays.

Posting runs the same checks as the **Post** button. When an approval workflow
applies to the bill, it is submitted for approval instead, and the message
says so.

## Pickers

- Typing on a closed picker opens it already searching. Matches are ranked:
  the start of a name first, then codes and account numbers, then words
  inside the name.
- **Enter** or **Tab** takes the highlighted match and moves to the next field.
  **Esc** closes the list and keeps the old value. **F4** opens the list.
- On a vendor or customer picker, when nothing matches, **↓** then **Enter**
  creates the vendor or customer with the name you typed. Enter alone never
  creates one, so a typing slip cannot add a vendor.

## Recall and duplicates

- When you pick a vendor, OpenBooks offers the lines of their last bill.
  **Ctrl+Alt+L** (or **Use its lines**) fills them in; change anything that
  differs, or choose **Undo**. A personal preference can fill them
  automatically or turn the offer off.
- As soon as you type a vendor's invoice number, a bill already entered with
  the same number (ignoring spaces, dashes and capitals) is shown above the
  form. Saving asks first, and **Enter** on that question cancels.

## Lines

| Key | What it does |
| --- | --- |
| Enter | Next line (or next field — see preferences) |
| Shift+Enter | Previous line |
| ↑ and ↓ | Move between lines in the same column |
| Tab on the last field | Start a new line |
| Alt+Enter / Alt+Shift+Enter | Insert a line below / above |
| F8 or Ctrl+' | Copy the field from the line above |
| Ctrl+D (⌘D) | Duplicate the line |
| Ctrl+Backspace (⌘⌫) | Remove the line |
| Alt+↑ / Alt+↓ | Move the line up or down |
| Shift+F10 | Line menu, including **Show all columns** |

Quantity, unit price and dimension columns stay out of the way until a line
uses them or you choose **Show all columns**. Administrators can change this
for a form in **Customize**.

**Pasting from a spreadsheet:** copy rows from Excel or Google Sheets and
paste them into the lines. Values land from the field you paste into; a first
row naming the columns is matched by name. Accounts match by number or name.
Anything that does not match is marked on its cell, with what was pasted.

## Amounts

- Arithmetic works in any amount: **200+47.83**, **=12*4.5**, **(100-15)/2**.
  The result is exact and shown as you type.
- **Control total:** type the total printed on the vendor's invoice in the
  footer. Saving waits until the lines add up to it, and the difference is
  shown in red while they do not.

## Journal entries

A new journal entry opens with the cursor in **Date**; currency, exchange rate
and other options are under **More options**. When the entry is out of
balance, moving to the amount of a line that has none fills in the amount
that balances it, selected so that typing replaces it. **Ctrl+Enter** posts
and starts the next entry.

## Lists

On Bills and Invoices, **j** and **k** move between rows, **Enter** opens the
highlighted one, **x** selects it and **Shift+x** extends the selection.
**Post selected** and **Submit selected** run each document through its own
checks and list any that were refused, with the reason.

## Search and commands

**Ctrl+K** (⌘K) searches everything. Typing what you want to do — **new bill**,
**invoice**, **batch** — offers it as an action at the top of the results.

## Field help

Help icons are skipped by Tab so the keyboard only visits fields. Press **F1**
in any field to read its help.

## Personal entry preferences

Open your account menu and choose **Data entry** (also at the bottom of the
**?** sheet):

- **Enter moves to the next field** — Enter walks across a line and on to the
  next one, as in desktop accounting systems.
- **Place the decimal point automatically** — type **1785** for 17.85, for
  ten-key entry.
- **Keep the date** and **Keep the vendor or customer** on Save & new.
- **When you pick a vendor or customer** — offer their last lines, fill them
  automatically, or do not recall.

Preferences change how the keyboard behaves for you only; every amount,
account and date is still checked the same way.
`,
};
