import type { DocArticle } from '../types'

export const taxConfiguration: DocArticle = {
  slug: 'tax-configuration',
  title: 'Tax Codes, Rates, and Returns',
  category: 'administration',
  order: 2,
  summary:
    'Configure tax-code posting, effective rates, and the return boxes that map ledger activity into jurisdiction filings.',
  updated: '2026-07-22',
  keywords: ['tax code', 'tax rate', 'tax return', 'return box', 'filing', 'formula', 'tax mapping', 'nexus', 'jurisdiction', 'facsimile', 'form pdf'],
  related: ['company-settings', 'accounting-model', 'audit-log'],
  body: `# Tax Codes, Rates, and Returns

Use **Settings → Company Setup → Taxes → Tax Codes** to define how tax is
selected and posted. Each code identifies whether it applies to sales,
purchases, or both; the collected and paid accounts; and the recoverable
percentage.

## Calculation behavior

Each code has a **Calculation type**:

- **Standard tax** posts collected tax on sales and input tax on purchases.
- **Withholding tax** reduces the amount payable or receivable and posts the
  withheld amount to its configured withholding account.
- **Reverse charge** records both output tax and the recoverable input portion;
  any nonrecoverable portion remains in transaction cost.

Use **Recoverable %** to split purchase or reverse-charge tax between the input
tax account and transaction cost. **Price includes tax** extracts tax from the
entered gross price instead of adding it. **Compound on previous components**
adds earlier group components to the next component's taxable base. **Tax
rounding decimals** controls component rounding from zero through four decimal
places. Withholding and reverse-charge codes cannot be marked inclusive.

## Tax groups and posting evidence

A **Tax Group** applies its member codes in sequence. The engine calculates
every component with exact decimal arithmetic, including inclusive extraction,
compound bases, recoverability, withholding, and reverse charge. The line total
must cross-foot to the saved component snapshots before posting.

Those snapshots are immutable accounting evidence after posting. Changing a
tax code or an effective rate later does not rewrite the calculation that
supported an existing transaction.

Open a tax code and choose the **Tax Rates** subtab to maintain its rate
history. Rates are effective-dated so a new statutory rate does not rewrite
transactions from an earlier period. The open tax code is fixed on every rate
created or edited from this subtab.

## Jurisdictions and nexus

**Taxes → Tax Jurisdictions** holds the countries, states, and localities that
levy indirect tax — each with a level (country, state, county, city) and tax
type (VAT, GST, sales & use). Jurisdictions can nest, so a US city rolls up to
its state and country. Installing a return pack creates its jurisdiction
automatically.

**Taxes → Tax Nexus** records where the business is actually registered to
collect and remit: the jurisdiction, the government registration number, the
filing frequency, and the return it files. This is the source of truth for your
filing calendar — the concrete return periods that come due — rather than
inferring obligations from whichever tax codes happen to exist. Tax codes and
returns both point at a structured jurisdiction.

## Install a maintained return

Open **Tax Returns** and choose **Library**. Search the maintained list, then
select every available pack you want
to install. **Install selected** imports the chosen packs together. Installed
packs remain visible with an explicit **Reset** action;
resetting replaces that return's configured structure, so review local
customizations before confirming the action.

On a return's **Details** tab, **Filing method** is the single control for how
the jurisdiction accepts the return. The compatible government format is
derived automatically, preventing contradictory method and format settings.
Choose **Country** from the searchable ISO country list; arbitrary country
codes are rejected by both the editor and imports.

## Configure return boxes

Open **Tax Returns**, select a return, and choose the **Tax Return Boxes**
subtab. This list is the complete filing structure for the open return,
including:

- boxes mapped directly to tax codes;
- calculation-only boxes; and
- manual boxes.

Choose **New tax return box** to add a box. The open return's **Report code** is
fixed automatically. Set **Line code** to the jurisdiction's box or line
identifier. For a mapped box, select **Tax code** and use **Basis** to control
what is summed from transactions using that code:

- **Tax collected** uses the tax posted to the collected account;
- **Tax paid** uses the tax posted to the paid or recoverable account;
- **Tax amount** uses every tax line for the code; and
- **Taxable base** uses the transaction amount on which tax was calculated.

Use **Sign** when the jurisdiction presents the amount with the opposite sign.
Use **PDF field** only when an uploaded official form exposes a matching
fillable field.

## Calculation-only boxes

A box with no tax code may use **Formula** to derive its value from sibling line
codes, such as **105 - 108**. Formula boxes appear once in their Tax Return
flyout alongside the boxes they combine.

Leave both **Tax code** and **Formula** blank only for a manual box whose value
must be entered while preparing the filing.

## Form PDF and official form

Prepare a return, then **Form PDF** downloads a form-faithful facsimile — a
working copy laid out like the real government return (agency masthead, numbered
line grid, section headings), populated from your ledger and watermarked
not-for-filing. This is generated from your own template, so it works for every
jurisdiction, including the API- and portal-only returns that have no fillable
government PDF.

If a jurisdiction publishes a fillable official PDF, upload it on the return and
map each box to its AcroForm field; **Filled official form** then fills and
flattens that PDF. openbooks never bundles government PDFs — you supply the copy
you are entitled to.

## Validate before filing

Prepare the return for a representative open period and reconcile every box to
the tax accounts and transaction detail. Confirm formula signs, recoverability,
rounding, and the filing period. Archive obsolete tax codes instead of changing
the meaning of codes already used on posted transactions.
`,
}
