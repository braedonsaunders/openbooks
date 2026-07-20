import type { DocArticle } from '../types'

export const welcome: DocArticle = {
  slug: 'welcome',
  title: 'Welcome to OpenBooks',
  category: 'getting-started',
  order: 1,
  summary: 'What OpenBooks is, how the documentation is organized, and where to start.',
  updated: '2026-07-19',
  keywords: ['intro', 'overview', 'help', 'start'],
  body: `# Welcome to OpenBooks

OpenBooks is a configurable accounting and operations platform. Almost every
accounting behaviour — how projects are costed, how invoices are built, how
revenue is recognized, what a document PDF looks like — is driven by settings
you control, not hardcoded. This documentation explains how those settings work
so you can configure the system to match your business exactly.

## How the docs are organized

Documentation is grouped into categories you can browse from the sidebar:

- **Getting Started** — orientation and core concepts.
- **Switching to OpenBooks** — familiarization guides for teams moving from
  NetSuite, QuickBooks, Odoo, Xero, or Sage Intacct.
- **Accounting Foundations** — the ledger model, transaction lifecycle, accounts,
  dimensions, and master data.
- **Sales & Purchases** — customer and vendor workflows, payments, and credits.
- **Banking & Close** — statement matching, reconciliation, and period close.
- **Projects & Billing** — project types, profitability, invoicing, and backup.
- **Reporting & Analytics** — financial statements, operational analytics, and
  saved views.
- **Integrations & Migration** — migration planning, proof, and source connections.
- **Apps & Extensions** — finding, installing, updating, and administering apps.
- **Administration** — setup, roles, imports, files, and audit evidence.

Use the search box at the top of the sidebar to jump straight to a topic.

## A note on configurability

Wherever you see a setting in the app, there is usually a matching article here
explaining what each option does and how the choices interact. If you are trying
to reproduce a specific behaviour (for example, matching a legacy system to the
penny), the relevant article will call out which options to combine.

## Getting help

Every configuration workspace links to its documentation with a **Documentation**
or **Learn more** link near the top of the page. Following that link brings you
straight to the article for what you are configuring.
`,
}
