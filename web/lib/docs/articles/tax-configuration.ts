import type { DocArticle } from '../types'

export const taxConfiguration: DocArticle = {
  slug: 'tax-configuration',
  title: 'Tax Codes, Rates, and Returns',
  category: 'administration',
  order: 2,
  summary:
    'Configure tax-code posting, effective rates, and the return boxes that map ledger activity into jurisdiction filings.',
  updated: '2026-07-21',
  keywords: ['tax code', 'tax rate', 'tax return', 'return box', 'filing', 'formula', 'tax mapping'],
  related: ['company-settings', 'accounting-model', 'audit-log'],
  body: `# Tax Codes, Rates, and Returns

Use **Settings → Company Setup → Taxes → Tax Codes** to define how tax is
selected and posted. Each code identifies whether it applies to sales,
purchases, or both; the collected and paid accounts; and the recoverable
percentage.

Open a tax code and choose the **Tax Rates** subtab to maintain its rate
history. Rates are effective-dated so a new statutory rate does not rewrite
transactions from an earlier period. The open tax code is fixed on every rate
created or edited from this subtab.

## Install a maintained return

Open **Tax Returns** and choose **Library**. Select a jurisdiction pack, then
import it or reset an installed return to the maintained defaults. Resetting
replaces that return's configured structure, so review local customizations
before confirming the action.

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

## Validate before filing

Prepare the return for a representative open period and reconcile every box to
the tax accounts and transaction detail. Confirm formula signs, recoverability,
rounding, and the filing period. Archive obsolete tax codes instead of changing
the meaning of codes already used on posted transactions.
`,
}
