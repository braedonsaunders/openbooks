import type { DocArticle } from '../types'

// One article per Company Setup menu group (the left rail in
// Settings → Company Setup). The registry (web/lib/setup/registry.ts) drives the
// rail; each group below documents the menu items it contains. Groups whose deep
// mechanics have their own articles (Taxes, Revenue, Projects) orient the reader
// and link onward rather than duplicating that content.

export const setupCompanyGroup: DocArticle = {
  slug: 'setup-company-group',
  title: 'Setup: Company',
  category: 'administration',
  order: 10,
  summary:
    'Organization identity, control accounts, subsidiaries, intercompany mapping, features, bank feeds, payments, and CRM defaults.',
  updated: '2026-07-22',
  keywords: [
    'company',
    'organization',
    'control accounts',
    'subsidiaries',
    'intercompany',
    'features',
    'bank feeds',
    'base currency',
    'fiscal year',
  ],
  related: ['company-settings', 'setup-accounting-group', 'setup-currency-group', 'roles-and-permissions'],
  body: `# Setup: Company

The **Company** group in **Settings → Company Setup** holds the organization's
identity and the tenant-wide defaults that every other module inherits.

## Company & Accounting

The first tab is the organization record itself:

- **Name** and **Legal name** — display and legal identity.
- **Country** — from the shared searchable ISO country list.
- **Base currency** — the organization's functional currency. Set this before
  posting; it anchors every conversion and consolidation.
- **Fiscal year start month** — drives period generation and annual reports.
- **Default locale** and **Report PDF style** — presentation defaults for new
  users and rendered statements.

### Control accounts

Control accounts route automatic postings to the correct ledger lines: **AR**,
**AP**, **Bank**, **Tax collected**, **Tax paid**, **Employee payable**,
**Unrealized FX gain/loss**, **Realized FX gain/loss**, **Labor WIP**, **Labor
clearing**, **Unbilled receivable**, and **Project revenue**. Configure the two
FX accounts before taking foreign-currency payments — a settlement that needs a
realized adjustment is refused until the realized account is set.

## Features

**Features** switches cross-company optional modules on or off. A domain with
material subordinate policies still keeps every feature gate on this single
authoritative switchboard. Projects, Field Tickets, Subscription Billing, and
all other optional capabilities are governed in **Company Settings → Features**;
module settings pages show status and configuration but never duplicate a switch.
Turning a feature off hides operational surfaces but never deletes its data —
the data returns if you re-enable it. A feature whose data is load-bearing for
the ledger or an open operational obligation cannot be turned off until that
dependency is resolved.

## Subsidiaries and Intercompany Pairs

With **multi-subsidiary** enabled:

- **Subsidiaries** form the legal-entity tree. Each entity's **base currency**
  is locked after creation so functional currency cannot drift once books exist.
  Mark elimination entities used only for consolidation.
- **Intercompany Pairs** map the **due-from** and **due-to** accounts used when a
  single transaction crosses two subsidiaries.
- **Subsidiary Ownership** records an effective-dated interest for each child.
  Choose full, proportionate, or equity-method treatment and configure the
  investment, equity-income, distribution, NCI, goodwill, and fair-value
  accounts. Full consolidation below 100% requires NCI accounts. Acquisition
  policy becomes immutable after it has produced consolidation evidence; end
  the interest and create a new dated policy instead of rewriting history.

At close, the consolidation action derives exact period FX rates, posts
acquisition/NCI or equity-method adjustments into the elimination entity, then
posts intercompany eliminations. Rerunning reverses the prior effective
adjustments before replacing them. Consolidated reports exclude equity-method
entities, apply exact ownership weights to proportionately consolidated
entities, and include elimination entries for fully consolidated entities.

## Bank Feeds, Payments & Banking, and CRM

- **Bank Feeds** (when enabled) configures the automated statement connections
  that feed the Banking module.
- **Payments & Banking** holds payment-method, remittance, and banking operation
  defaults used by pay runs and receipts.
- **CRM** sets pipeline and relationship defaults for the Customers workspace.

Search for an existing definition before creating one, use stable codes, and
test a change with a small transaction before relying on it.
`,
}

export const setupAccountingGroup: DocArticle = {
  slug: 'setup-accounting-group',
  title: 'Setup: Accounting',
  category: 'administration',
  order: 11,
  summary: 'Accounting books and the governed period-close configuration.',
  updated: '2026-07-21',
  keywords: ['accounting books', 'primary book', 'period close', 'close policy', 'multi-book'],
  related: ['setup-company-group', 'financial-reports', 'company-settings'],
  body: `# Setup: Accounting

The **Accounting** group configures the books that postings land in and the
governed process that closes each period.

## Period Close

**Period Close** configures the close policy, automation, and the report package
delivered at close. Every posting, close run, budget, and book-aware schedule
belongs to an accounting book, and the close engine reads that configuration to
lock periods, run checklists, and publish the package. Configuration here is
edited in structured editors rather than raw settings so policy, automation, and
package parameters stay reviewable.

## Accounting Books

**Accounting Books** define the ledgers you post to:

- **Code** and **Name** — the book's stable identity (code is locked after
  creation).
- **Primary** — exactly one book is the primary posting book. The API enforces
  the single-active-primary rule atomically when books change.
- **Posts GL** — whether the book contributes to the general ledger.

Use a secondary (non-primary) book for a tax or alternate-GAAP view that runs
different policies — for example, a different depreciation method per category
(see **Assets → Book Depreciation Policies**). Archiving a book preserves its
history while preventing new selection.
`,
}

export const setupTaxesGroup: DocArticle = {
  slug: 'setup-taxes-group',
  title: 'Setup: Taxes',
  category: 'administration',
  order: 12,
  summary: 'Jurisdictions, nexus, codes, rates, groups, and configurable government returns.',
  updated: '2026-07-21',
  keywords: ['tax', 'jurisdiction', 'nexus', 'tax code', 'tax rate', 'tax group', 'tax return', 'VAT', 'GST'],
  related: ['tax-jurisdictions-and-nexus', 'tax-configuration', 'tax-returns-and-boxes', 'setup-assets-group'],
  body: `# Setup: Taxes

The **Taxes** group turns tax law into data: where you are registered, what you
charge, and which government return the ledger settles to. It starts with a
**Tax Setup** guide that walks a new organization through the sequence below.

## The menu items

- **Tax Jurisdictions** — the taxing authorities (country, state, county, city,
  special, federal) and their tax type (VAT, GST, HST, PST, QST, sales/use,
  consumption). Jurisdictions can nest.
- **Tax Nexus** — your registrations in each jurisdiction, including
  registration number, filing frequency, return form, and effective dates.
- **Tax Codes** — what actually applies to a line: which side it applies to,
  standard/withholding/reverse-charge calculation, the collected, paid, and
  withholding accounts, recoverable percent, and price-inclusive behavior.
  Effective-dated **Tax Rates** live inside each code's flyout.
- **Tax Groups** — bundle several codes that apply together.
- **Tax Returns** — a configurable government return. OpenBooks computes the
  boxes from the ledger, renders a form-faithful facsimile, and routes filing to
  the jurisdiction's real channel. The box-to-ledger mapping lives in each
  return's **Tax Return Boxes** flyout.

A new jurisdiction is data — a form and its boxes — not new code.

The Taxes documentation section covers each area in depth:

- **Tax Jurisdictions and Nexus** — the authorities and your registrations.
- **Tax Codes, Rates, and Groups** — how tax is calculated and posted.
- **Tax Returns and Boxes** — how ledger activity becomes a filed return.
`,
}

export const setupDimensionsGroup: DocArticle = {
  slug: 'setup-dimensions-group',
  title: 'Setup: Dimensions',
  category: 'administration',
  order: 13,
  summary: 'Departments, locations, classes, custom segments, and account-group classification.',
  updated: '2026-07-21',
  keywords: ['dimensions', 'department', 'location', 'class', 'segment', 'account group', 'analysis'],
  related: ['chart-of-accounts-and-dimensions', 'company-settings', 'financial-reports'],
  body: `# Setup: Dimensions

Dimensions are the analysis axes tagged onto transactions so reports can slice
the ledger by more than account. The **Dimensions** group manages the built-in
axes, any custom ones, and the reporting classification of the chart of accounts.

## The menu items

- **Departments**, **Locations**, and **Classes** — the three built-in
  dimensions. Each supports a stable **code**, hierarchy through a parent, and an
  optional subsidiary scope (with or without children).
- **Segments** — define your own custom dimensions. A segment sets its key,
  singular and plural names, hierarchy, and where it appears (header, lines,
  reports) and whether accounts may require it. A custom segment's **Values** are
  managed inside its own drawer; built-in dimension values stay on their own tabs.
- **Account Groups** — a rule-plus-pin classification of the chart of accounts,
  scoped to a dimension. Groups drive reporting rollups and cost-pool
  membership. This tab manages a group's identity (name, color, order, active);
  its match rule and membership pins are managed on the chart of accounts.

Keep codes stable — dimension codes appear on posted activity, so changing a
code's meaning after it has been used rewrites the meaning of history.
`,
}

export const setupBillingGroup: DocArticle = {
  slug: 'setup-billing-group',
  title: 'Setup: Billing & Numbering',
  category: 'administration',
  order: 15,
  summary: 'Payment terms and gapless, per-document number sequences.',
  updated: '2026-07-21',
  keywords: ['payment terms', 'number sequence', 'document numbering', 'gapless', 'prefix', 'discount'],
  related: ['item-rates', 'sales-workflow', 'company-settings'],
  body: `# Setup: Billing & Numbering

The **Billing & numbering** group controls the invoice workflows offered by the
company, the terms offered to counterparties, and the document numbers your
records carry.

## Invoicing

**Invoicing** is the authoritative company policy for customer-invoice
workflows:

- standard one-time invoicing is a core capability and remains available;
- subscription billing is gated on **Company Settings → Features** for
  plan-and-schedule based recurring invoices, and cannot be disabled while
  active subscriptions would stop billing; and
- project invoicing reflects the authoritative **Projects** parent gate. Its
  procedures are assigned by project type. Progress and final are invoice
  stages, not independent modules or parallel billing engines.

Project configuration stays in **Company Settings → Projects** and **Project
Types**, while the gate stays on **Features**, so policy never has two competing
sources of truth.

## Payment Terms

**Payment Terms** define due dates and early-payment discounts: **Net days**, the
optional **Discount days**, and **Discount percent**. Terms are selected on
customer and vendor documents to compute due dates and available discounts.

## Number Sequences

**Number Sequences** control how each document kind is numbered:

- **Document kind** and optional **Subsidiary** — the scope of the sequence
  (both locked after creation).
- **Prefix**, **Next number**, and **Padding** — the formatting of the printed
  number.
- **Gapless** — when on, the sequence guarantees no gaps, which regulators often
  require for invoices. A gapless sequence trades a little concurrency for that
  guarantee.

Set a subsidiary-scoped sequence when different legal entities must not share a
run of invoice numbers.

## Rate books

Customer and project pricing (**Item Rate Books** and their assignments) is
configuration too, but it lives on the **Items** catalog and on the customer and
project records rather than this rail. See **Item Rate Books** for how dated,
customer- and project-scoped pricing resolves.
`,
}

export const setupRevenueGroup: DocArticle = {
  slug: 'setup-revenue-group',
  title: 'Setup: Revenue',
  category: 'administration',
  order: 16,
  summary: 'Reusable ASC 606 / IFRS 15 recognition rules and standalone selling prices.',
  updated: '2026-07-21',
  keywords: ['revenue recognition', 'ASC 606', 'IFRS 15', 'recognition rule', 'fair value', 'SSP', 'deferred revenue'],
  related: ['revenue-recognition', 'setup-billing-group'],
  body: `# Setup: Revenue

The **Revenue** group holds the reusable recipes that turn a performance
obligation into a recognition schedule.

## Recognition Rules

A **Recognition Rule** is the reusable ASC 606 / IFRS 15 recipe applied to an
obligation: the **method** (point in time, straight-line variants, percent
complete, milestone, or usage), the **start** and **end** date sources, period
and day offsets, an optional initial-recognition percent, and the **deferred**
and **recognized** accounts it posts to. A **forecast** rule models revenue
without posting.

## Fair value prices

Standalone selling prices used to allocate a bundle's transaction price across
obligations are dated per item and currency. They are configuration, but they
live on the item record (a Fair Value section) rather than this rail.

For the full model — obligations, allocation, schedules, and the close-time
recognition run — see **Revenue Recognition**.
`,
}

export const setupWorkforceGroup: DocArticle = {
  slug: 'setup-workforce-group',
  title: 'Setup: Workforce',
  category: 'administration',
  order: 17,
  summary: 'Time types and worker-compensation groups used by timesheets and labor costing.',
  updated: '2026-07-21',
  keywords: ['workforce', 'time type', 'worker comp', 'billable', 'cost multiplier', 'bill multiplier', 'labor'],
  related: ['labor-costing', 'labor-pricing', 'company-settings'],
  body: `# Setup: Workforce

The **Workforce** group configures how time is classified and how workers are
grouped for insurance costing. Both feed timesheets, field tickets, and the labor
costing engine.

## Time Types

A **Time Type** classifies an hour and carries a **Cost multiplier** and **Bill
multiplier** applied to the base rate — for example, an overtime type at 1.5×
cost. **Billable by default** sets the initial billable flag on new entries of
that type. **Show on field tickets** opts the type into the compact crew grid
without changing its availability in timesheets, pricing, imports, or costing.

## Worker Comp Groups

A **Worker Comp Group** carries a **code**, name, and **rate percent** used to
estimate workers' compensation cost. Groups are assigned to workers so labor
burden reflects each class of work.

These settings are estimate inputs to labor rates. They never post overhead into
the ledger on their own — see **Labor Costing** and **Labor Pricing** for how
wage, burden, and overhead are kept as separate, correctly-posted layers.
`,
}

export const setupAssetsGroup: DocArticle = {
  slug: 'setup-assets-group',
  title: 'Setup: Assets',
  category: 'administration',
  order: 18,
  summary: 'Asset categories, depreciation methods and book policies, and configurable tax-depreciation regimes.',
  updated: '2026-07-21',
  keywords: [
    'fixed assets',
    'asset category',
    'depreciation method',
    'book policy',
    'tax regime',
    'CCA',
    'capital allowance',
    'first-year rule',
  ],
  related: ['setup-accounting-group', 'tax-configuration', 'company-settings'],
  body: `# Setup: Assets

The **Assets** group defines how fixed assets post, depreciate, and are treated
for tax.

## Asset Categories

An **Asset Category** binds a class of assets to its accounts (**asset**,
**accumulated depreciation**, **depreciation expense**, and optional
**gain/loss**) and its default depreciation **method**, **convention**, and
**life in months**. New assets inherit these defaults.

## Depreciation Methods and Book Policies

- **Depreciation Methods** is a formula builder: author a method as a formula
  over the depreciation variable set (net book value, original cost, residual
  value, asset life, current period, and so on), and choose end-of-life behavior.
  Categories reference a method by code.
- **Book Depreciation Policies** set a per-book, per-category policy so a tax or
  alternate book depreciates differently from the primary posting book.

## Tax depreciation

For jurisdictions that pool assets, these tabs make the regime data, not code:

- **Tax Depreciation Regimes** — a jurisdiction's regime (built-ins include
  Canadian CCA, UK WDA, and Australian and New Zealand pools). Add one the engine
  does not ship, or shadow a built-in.
- **Tax Depreciation Classes** — per-regime pool classes: rate, method, first-year
  fraction, and recapture / terminal-loss behavior.
- **First-Year Rules** — dated first-year treatment per regime and class
  (half-year rule, accelerated investment incentive, immediate expensing), kept
  as configuration because it changes with legislation.

See **Tax Configuration** for how these regimes flow into tax returns.
`,
}

export const setupCurrencyGroup: DocArticle = {
  slug: 'setup-currency-group',
  title: 'Setup: Currency',
  category: 'administration',
  order: 19,
  summary: 'Currencies, an exchange-rate provider, dated FX rates, and consolidation rates.',
  updated: '2026-07-21',
  keywords: ['currency', 'exchange rate', 'FX', 'fx provider', 'consolidation', 'multi-currency', 'revaluation'],
  related: ['setup-company-group', 'setup-accounting-group', 'financial-reports'],
  body: `# Setup: Currency

The **Currency** group (shown when **multi-currency** is enabled) manages the
currencies you transact in and the rates that convert and consolidate them.

## FX Provider

**FX Provider** connects an automated exchange-rate source so daily rates are
fetched rather than keyed by hand. Provider credentials are sealed and managed
through the connection UI, not ordinary settings.

## Exchange Rates

**Exchange Rates** are dated rates between two currencies for a **rate type**
(spot, average, or historical) with a **source**. The date, currencies, rate
type, and source are locked after creation so a stored rate is never silently
redefined; correct a mistake by adding a new dated rate.

## Consolidated Exchange Rates

With **multi-subsidiary** enabled, **Consolidated Exchange Rates** hold the
per-period current, average, and historical rates used to translate a
subsidiary's books into the consolidation currency, sourced either as derived or
manual.

## Currencies

**Currencies** is the shared reference of currency codes and their minor units
(decimal places). It is the one setup table that is not organization-scoped.
`,
}

export const setupProjectsGroup: DocArticle = {
  slug: 'setup-projects-group',
  title: 'Setup: Projects',
  category: 'administration',
  order: 14,
  summary: 'Project types, the overhead model, and labor costing and pricing.',
  updated: '2026-07-21',
  keywords: ['projects', 'project type', 'overhead model', 'labor costing', 'labor pricing', 'profitability', 'billing'],
  related: ['project-types', 'overhead-costing', 'labor-costing', 'labor-pricing'],
  body: `# Setup: Projects

The **Projects** group owns project-accounting configuration. The authoritative
Projects and Field Tickets gates live on **Company Settings → Features**. The
configuration workspaces appear after the parent gate is enabled. No project API
or background operation remains available when the parent gate is off, and
disabling it never deletes history.

## The menu items

- **Project Types** — per-type profiles for profitability, invoicing, and invoice
  backup. A type also selects the billing procedure: standard project billing
  requests or Schedule-of-Values applications for payment. See **Project Types**.
- **Applications for Payment** — cumulative Schedule-of-Values billing, change
  orders, retainage, and retainage release. This is a Projects billing procedure,
  not an independent feature or module.
- **Overhead Model** — the department-composite-rate engine that spreads overhead
  onto projects. Overhead is kept net-zero to the company P&L: it is report-only
  or posted as a job-tagged debit against an untagged credit, never as a one-sided
  absorption. See **Overhead Costing**.
- **Labor Costing** — wage rates and the components of a labor hour (wage, direct
  payroll burden, overhead), plus net-zero pairs and payroll true-up. See
  **Labor Costing**.
- **Labor Pricing** — the bill-rate tiers charged for labor, kept separate from
  cost. See **Labor Pricing**.

The guiding rule across these workspaces: wage, estimated burden, and overhead
are three distinct layers. Overhead never flows into labor rates, and never
changes total company profit.
`,
}

export const companySetupGroupArticles: DocArticle[] = [
  setupCompanyGroup,
  setupAccountingGroup,
  setupTaxesGroup,
  setupDimensionsGroup,
  setupBillingGroup,
  setupRevenueGroup,
  setupWorkforceGroup,
  setupAssetsGroup,
  setupCurrencyGroup,
  setupProjectsGroup,
]
