import type { DocArticle } from '../types'

export const taxConfiguration: DocArticle = {
  slug: 'tax-configuration',
  title: 'Tax Codes, Rates, and Groups',
  category: 'administration',
  order: 2,
  summary:
    'Define how tax is selected and posted: calculation type, recoverability, inclusive pricing, effective-dated rates, and sequenced tax groups.',
  updated: '2026-07-21',
  keywords: [
    'tax code',
    'tax rate',
    'tax group',
    'calculation type',
    'withholding',
    'reverse charge',
    'recoverable',
    'price includes tax',
    'compound',
    'effective date',
  ],
  related: ['tax-jurisdictions-and-nexus', 'tax-returns-and-boxes', 'setup-taxes-group', 'accounting-model'],
  body: `# Tax Codes, Rates, and Groups

A **tax code** is the unit of tax configuration: it decides how tax is selected on
a line, how it is calculated, and where it posts. Use **Settings → Company Setup →
Taxes → Tax Codes** to manage them. Each code identifies whether it applies to
sales, purchases, or both; its collected, paid, and withholding accounts; and its
recoverable percentage.

## Calculation behavior

Each code has a **Calculation type**:

- **Standard tax** posts collected tax on sales and input tax on purchases.
- **Withholding tax** reduces the amount payable or receivable and posts the
  withheld amount to its configured withholding account.
- **Reverse charge** records both output tax and the recoverable input portion;
  any nonrecoverable portion remains in transaction cost.

Fine-grained controls:

- **Recoverable %** splits purchase or reverse-charge tax between the input tax
  account and transaction cost.
- **Price includes tax** extracts tax from the entered gross price instead of
  adding it. Withholding and reverse-charge codes cannot be marked inclusive.
- **Compound on previous components** adds earlier group components to the next
  component's taxable base.
- **Tax rounding decimals** controls component rounding from zero through four
  decimal places.

## Effective-dated rates

Open a tax code and choose the **Tax Rates** subtab to maintain its rate history.
Rates are **effective-dated** so a new statutory rate never rewrites transactions
from an earlier period — the applicable rate is the one in effect on the
transaction date. The open tax code is fixed on every rate created or edited from
this subtab, so a rate can only ever belong to the code you opened.

## Tax groups

A **Tax Group** (Taxes → Tax Groups) applies its member codes in sequence — the
mechanism behind combined taxes such as a state plus city rate, or a GST plus PST
pair. The engine calculates every component with exact decimal arithmetic,
including inclusive extraction, compound bases, recoverability, withholding, and
reverse charge. The line total must cross-foot to the saved component snapshots
before posting.

## Posting evidence is immutable

Those component snapshots are permanent accounting evidence after posting.
Changing a tax code or an effective rate later does **not** rewrite the
calculation that supported an existing transaction. Archive an obsolete code
rather than repurposing one already used on posted activity. Changing its meaning
would conflict with the evidence retained for prior transactions.

## Where codes fit

Codes attach to a structured **jurisdiction** and feed the **return boxes** that
become a government filing. Configure those alongside your codes:

- **Tax Jurisdictions and Nexus** — the authorities that levy tax and where you
  are registered to file.
- **Tax Returns and Boxes** — how ledger activity for each code rolls up into a
  filed return.

Test a new code with a small transaction in an open period and review the
generated tax lines before relying on it.
`,
}
