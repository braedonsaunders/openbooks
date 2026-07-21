import type { DocArticle } from '../types'

export const taxConfiguration: DocArticle = {
  slug: 'tax-configuration',
  title: 'Tax Codes and Return Boxes',
  category: 'administration',
  order: 2,
  summary:
    'Configure tax-code posting, effective rates, and the return boxes that map ledger activity into jurisdiction filings.',
  updated: '2026-07-21',
  keywords: ['tax code', 'tax rate', 'tax return', 'return box', 'filing', 'formula', 'tax mapping'],
  related: ['company-settings', 'accounting-model', 'audit-log'],
  body: `# Tax Codes and Return Boxes

Use **Settings → Company Setup → Taxes → Tax Codes** to define how tax is
selected and posted. Each code identifies whether it applies to sales,
purchases, or both; the collected and paid accounts; and the recoverable
percentage.

Keep rates in **Tax Rates**. Rates are effective-dated so a new statutory rate
does not rewrite transactions from an earlier period.

## Map a tax code to a return

Open a tax code and choose the **Tax Return Boxes** subtab. The list contains:

- boxes mapped directly to the open tax code; and
- calculation-only or manual boxes shared by the return.

Choose **New tax return box** to add a mapping. The open tax code is selected by
default. Set **Report code** to the code of its configured tax return and **Line
code** to the jurisdiction's box or line identifier. **Basis** controls what is
summed from transactions using the tax code:

- **Tax collected** uses the tax posted to the collected account;
- **Tax paid** uses the tax posted to the paid or recoverable account;
- **Tax amount** uses every tax line for the code; and
- **Taxable base** uses the transaction amount on which tax was calculated.

Use **Sign** when the jurisdiction presents the amount with the opposite sign.
Use **PDF field** only when an uploaded official form exposes a matching
fillable field.

## Calculation-only boxes

A box with no tax code may use **Formula** to derive its value from sibling line
codes, such as **105 - 108**. Formula boxes appear in every Tax Code flyout
mapped to the same return, so they remain available alongside the boxes they
combine. Edit a shared formula once; it is the same return box wherever it
appears.

Leave both **Tax code** and **Formula** blank only for a manual box whose value
must be entered while preparing the filing.

## Validate before filing

Prepare the return for a representative open period and reconcile every box to
the tax accounts and transaction detail. Confirm formula signs, recoverability,
rounding, and the filing period. Archive obsolete tax codes instead of changing
the meaning of codes already used on posted transactions.
`,
}
