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

OpenBooks is a configurable accounting and operations platform. Core accounting
behavior, including project costing, invoice construction, revenue recognition,
and document presentation, is controlled through organization settings. This
documentation describes those settings and their operational effects.

## How the docs are organized

Documentation is grouped into categories you can browse from the sidebar:

- **Getting Started** — orientation and core concepts.
- **Switching to OpenBooks** — familiarization guides for teams moving from
  small-business or enterprise accounting systems.
- **Accounting Foundations** — the ledger model, transaction lifecycle, accounts,
  dimensions, and master data.
- **Sales & Purchases** — customer and vendor workflows, payments, and credits.
- **Banking & Close** — statement matching, reconciliation, and period close.
- **Projects & Billing** — project types, profitability, invoicing, and backup.
- **Reporting & Analytics** — financial statements, operational analytics, and
  saved views.
- **Integrations & Migration** — migration planning, proof, and source connections.
- **Apps & Extensions** — finding, installing, updating, and administering apps.
- **Settings** — company setup, administration, customization, automation, and extensions.

Use the search box at the top of the sidebar to locate an article by topic.

## Configuration references

Configuration articles explain available options and their interactions. Where
applicable, they also document the settings required to align behavior with an
existing accounting policy or source system.

## Getting help

Every configuration workspace links to its documentation with a **Documentation**
or **Learn more** link near the top of the page. The link opens the article for
the applicable configuration area.
`,
}
