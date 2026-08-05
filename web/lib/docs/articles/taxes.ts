import type { DocArticle } from '../types'

export const taxJurisdictionsAndNexus: DocArticle = {
  slug: 'tax-jurisdictions-and-nexus',
  title: 'Tax Jurisdictions and Nexus',
  category: 'administration',
  order: 1,
  summary:
    'Model the authorities that levy indirect tax and record where the business is registered to collect and remit.',
  updated: '2026-07-21',
  keywords: [
    'tax jurisdiction',
    'nexus',
    'registration',
    'filing frequency',
    'filing calendar',
    'VAT',
    'GST',
    'sales and use',
    'return pack',
  ],
  related: ['tax-configuration', 'tax-returns-and-boxes', 'setup-taxes-group'],
  body: `# Tax Jurisdictions and Nexus

Before configuring codes and returns, distinguish jurisdictions where tax
applies from jurisdictions where the organization is registered. OpenBooks
models these concepts separately.

## Tax Jurisdictions

**Taxes → Tax Jurisdictions** holds the countries, states, and localities that
levy indirect tax. Each jurisdiction has:

- a **level** — country, state, county, city, special, or federal; and
- a **tax type** — VAT, GST, HST, PST, QST, sales & use, consumption, or other.

Jurisdictions **nest**, so a US city rolls up to its state and its country, and a
report can aggregate at any level. Choose **Country** from the searchable ISO
country list; arbitrary country codes are rejected. Installing a maintained
return pack creates its jurisdiction automatically, so manual creation is
typically unnecessary for a supported filing.

Tax codes and returns both point at a structured jurisdiction rather than a
free-text label. This structure allows the same code to support posting and
filing.

## Tax Nexus

**Taxes → Tax Nexus** records where the business is **registered** to
collect and remit tax:

- the **jurisdiction** you are registered in;
- the government **registration number**;
- the **filing frequency** (monthly, bimonthly, quarterly, semiannual, or
  annual); and
- the **return** you file there, with its effective dates.

Nexus is the authoritative configuration for the **filing calendar** — the return
periods that come due — rather than inferring obligations from whichever tax
codes happen to exist. A code can exist without an obligation to file; nexus
determines the filing obligation.

## Maintain jurisdiction and nexus alignment

Register nexus for every jurisdiction where you have an obligation, and retire a
registration (with its effective-to date) when it ends rather than deleting it,
so historical periods still reflect what was true at the time. From here, move on
to **Tax Codes, Rates, and Groups** to define what you charge, and **Tax Returns
and Boxes** to configure the filing structure.
`,
}

export const taxReturnsAndBoxes: DocArticle = {
  slug: 'tax-returns-and-boxes',
  title: 'Tax Returns and Boxes',
  category: 'administration',
  order: 3,
  summary:
    'Install maintained returns, map ledger activity into return boxes, and produce a form-faithful filing PDF.',
  updated: '2026-07-21',
  keywords: [
    'tax return',
    'return box',
    'filing',
    'return pack',
    'basis',
    'formula',
    'form pdf',
    'facsimile',
    'official form',
    'AcroForm',
  ],
  related: ['tax-configuration', 'tax-jurisdictions-and-nexus', 'setup-taxes-group'],
  body: `# Tax Returns and Boxes

A **return** turns ledger activity into a government filing. OpenBooks computes
each box from posted tax, renders a form-faithful copy, and routes filing to the
jurisdiction's designated channel. Jurisdiction-specific forms and boxes are
configured as data without application code changes.

## Install a maintained return

Open **Taxes → Tax Returns** and choose **Library**. Search the maintained list,
select the required packs, and choose **Install selected** to import them
together. Installed packs remain visible with an explicit **Reset** action;
resetting replaces that return's configured structure, so review local
customizations before confirming.

On a return's **Details** tab, **Filing method** is the single control for how the
jurisdiction accepts the return. The compatible government format is derived
automatically, preventing contradictory method and format settings. Choose
**Country** from the searchable ISO country list; arbitrary codes are rejected by
both the editor and imports.

## Configure return boxes

Select a return and choose the **Tax Return Boxes** subtab — the complete filing
structure for that return. It holds three kinds of box:

- **mapped** boxes tied to a tax code;
- **calculation-only** boxes derived from other boxes; and
- **manual** boxes entered while preparing the filing.

Choose **New tax return box** to add one. The open return's **Report code** is
fixed automatically. Set **Line code** to the jurisdiction's box or line
identifier. For a mapped box, select a **Tax code** and use **Basis** to control
what is summed from transactions using that code:

- **Tax collected** — the tax posted to the collected account;
- **Tax paid** — the tax posted to the paid or recoverable account;
- **Tax amount** — every tax line for the code; and
- **Taxable base** — the transaction amount on which tax was calculated.

Use **Sign** when the jurisdiction presents the amount with the opposite sign, and
**PDF field** only when an uploaded official form exposes a matching fillable
field.

### Calculation-only and manual boxes

A box with no tax code may use **Formula** to derive its value from sibling line
codes, such as **105 - 108**. Formula boxes appear once in their return flyout
alongside the boxes they combine. Leave both **Tax code** and **Formula** blank
only for a manual box whose value must be entered at filing time.

## Form PDF and the official form

Prepare a return, then **Form PDF** downloads a **form-faithful facsimile** — a
working copy laid out like the applicable government return (agency masthead, numbered
line grid, section headings), populated from your ledger and watermarked
not-for-filing. Organization templates support jurisdictions that use API or
portal filing and do not publish a fillable government PDF.

If a jurisdiction publishes a fillable official PDF, upload it on the return and
map each box to its AcroForm field; **Filled official form** then fills and
flattens that PDF. OpenBooks never bundles government PDFs — you supply the copy
you are entitled to.

## Validate before filing

Prepare the return for a representative open period and reconcile every box to the
tax accounts and transaction detail. Confirm formula signs, recoverability,
rounding, and the filing period before you submit. Nexus (see **Tax Jurisdictions
and Nexus**) determines which periods are due; reconciliation validates the
amounts reported for those periods.
`,
}
