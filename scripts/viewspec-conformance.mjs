#!/usr/bin/env node
/**
 * ViewSpec conformance harness.
 *
 * For every converted page, render it twice against the SAME request — once
 * through the native JSX and once through `ModuleView` — and prove the two are
 * indistinguishable. A page counts as converted only when this is clean; until
 * then the native branch stays and ships.
 *
 * This runs in a real browser, and that is not incidental. The first version
 * of this harness fetched the HTML with `fetch` and compared the `<main>`
 * subtree, and it reported four passing variants that were in fact four
 * identical copies of the streaming suspense fallback — the page content
 * arrives in later chunks that a single `fetch` never resolves. A harness that
 * cannot fail is worse than no harness, so the comparison happens after the
 * document has actually finished streaming and rendering.
 *
 * Two comparisons, because they catch different failures:
 *
 *   1. Structural — the settled DOM of the page's `<main>`, normalized and
 *      diffed node by node. Exact, and it is the gate. A DOM diff can say
 *      WHAT changed; a pixel diff cannot.
 *   2. Visual — a full-page screenshot compared pixel for pixel. Identical
 *      markup can still lay out differently, so this is the backstop.
 *
 * Normalization is deliberately narrow: React comment markers and per-render
 * `useId` values carry no user-visible meaning. Nothing else is stripped —
 * anything more and the harness would be lying to us.
 *
 * Usage:
 *   node scripts/viewspec-conformance.mjs                  # every registered page
 *   node scripts/viewspec-conformance.mjs /reports/partners
 *   VIEWSPEC_HEADED=1 node scripts/viewspec-conformance.mjs   # watch it run
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'

const BASE = process.env.VIEWSPEC_BASE_URL ?? 'http://localhost:4780'
const EMAIL = process.env.VIEWSPEC_EMAIL ?? 'viewspec@sim.test'
const PASSWORD = process.env.VIEWSPEC_PASSWORD ?? 'viewspec-dev'
const OUT_DIR = process.env.VIEWSPEC_OUT ?? join(process.cwd(), 'tmp', 'viewspec')
const VIEWPORT = { width: 1440, height: 900 }

/**
 * Pages under conversion. Each entry lists query variants that must ALL match:
 * one default render proves little on a page whose shape changes with its
 * filters, so variants pin the branches that matter — here both sides of the
 * payable/receivable toggle and a search that returns nothing.
 */
const PAGES = [
  {
    path: '/reports/partners',
    variants: [
      '',
      '?kind=payable',
      '?kind=receivable',
      // Deliberate empty result: assert the empty branch, not row content.
      { query: '?kind=receivable&q=zzzznomatch', expect: 'table thead th', minMatches: 1 },
    ],
    // Proof the page actually rendered. Without a positive content assertion a
    // capture taken during the loading screen compares blank against blank.
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/reports/pnl',
    // Exercise the statement matrix's real branches: comparison columns,
    // dimension breakout, and a scaled presentation.
    variants: ['', '?compare=prior_period', '?breakout=month', '?scale=thousands', '?showZero=1'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/journal',
    // Grouped/repeating content: entries with nested line tables.
    variants: ['', '?period=this_fiscal_year'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/general-ledger',
    // Repeating groups WITH spanning opening/closing summary rows.
    variants: ['', '?period=this_fiscal_year'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/orders',
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/data/import/history',
    // First app-variant list table (card chrome, sticky header, EmptyState).
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/reports/registers',
    variants: ['', '?side=ap'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/admin/api-keys',
    // Admin list: search bar, app table with an in-table empty row, drawer.
    variants: ['',
      // The flyout is portaled to <body>: without naming that root the
      // comparison never looks at the drawer at all.
      {
        query: '?key=01a08695-1e66-79ee-b02e-5c0de9c9e246',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table thead th',
  },
  {
    path: '/admin/custom-fields',
    variants: ['',
      // The flyout is portaled to <body>: without naming that root the
      // comparison never looks at the drawer at all.
      {
        query: '?field=01a086a0-1a2f-758f-b727-0741a0a1d23b',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/admin/scripts',
    variants: ['',
      // The flyout is portaled to <body>: without naming that root the
      // comparison never looks at the drawer at all.
      {
        query: '?script=01a086a2-303f-71da-9964-983ffc2a7ed8',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/reports/aging',
    // Two mutually exclusive tables selected by independent presence flags.
    variants: ['', '?view=detail', '?side=ap'],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    // A concrete party from the sim tenant — the one with the most ledger
    // activity, so the statement has real lines rather than only balances.
    path: '/reports/statements/11948e5b-2ca5-4d41-8ae4-c682f6f4b14c',
    // The AP side of this party carries two open items, not three; the
    // threshold asserts real rows, and two rows are real.
    variants: ['', { query: '?side=ap', expect: 'table tbody tr', minMatches: 2 }],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/reports/budget',
    // The native filter bar sets `sections` from DATA, which the spec cannot
    // do — so it places complementary filter bars behind loader flags.
    variants: [''],
    expect: 'main',
    minMatches: 1,
  },
  {
    path: '/reports/balance-sheet',
    // The statement archetype with an accounting-equation check under the
    // filter bar — a conditional pair the loader resolves.
    variants: ['', '?compare=prior_period', '?scale=thousands'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/trial-balance',
    // Body is one PaperView: a generic tabular report placed whole.
    variants: ['', '?period=this_fiscal_year'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/cash-flow',
    // Heterogeneous statement rows rendered from a flattened row list.
    variants: [{ query: '', expect: 'table tbody tr', minMatches: 6 }],
    expect: 'table tbody tr',
  },
  {
    path: '/reports/cash-flow-indirect',
    // Second consumer of the shared statement-row component.
    variants: [{ query: '', expect: 'table tbody tr', minMatches: 6 }],
    expect: 'table tbody tr',
  },
  {
    // An OPEN reconciliation: three prefixed panes and every mutation live in
    // one workspace component, placed whole.
    path: '/banking/a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e/reconcile/00000000-0000-7000-9000-000000000407',
    variants: [{ query: '', expect: 'main button', minMatches: 4 }],
    expect: 'main button',
    minMatches: 4,
  },
  {
    // The signed-off branch, which short-circuits before the panes load.
    path: '/banking/a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e/reconcile/00000000-0000-7000-9000-000000000405',
    variants: [{ query: '', expect: 'main', minMatches: 1 }],
    expect: 'main',
    minMatches: 1,
  },
  {
    path: '/apps',
    variants: [
      '',
      { query: '?q=demo', expect: 'main a[aria-label^="Open"]', minMatches: 1 },
      { query: '?q=zzzznomatch', expect: 'main h2', minMatches: 1 },
    ],
    expect: 'main a[aria-label^="Open"]',
    minMatches: 2,
  },
  {
    path: '/reports/custom/run/01a083e6-dce6-7158-aeab-dce836642ee9',
    // The saved-query runner: complementary filter bars behind loader flags,
    // the result paper placed whole, and an error branch that is a paper plus
    // a verbatim paragraph.
    variants: [
      '',
      { query: '?period=last_fiscal_year', expect: 'main p', minMatches: 1 },
    ],
    expect: 'table tbody tr',
    minMatches: 40,
  },
  {
    path: '/admin/setup/payment-operations',
    // Four mutually exclusive views; profiles is empty in this tenant, so the
    // default pins the in-table empty row with its headers intact.
    variants: [
      { query: '', expect: 'table thead th', minMatches: 4 },
      { query: '?view=formats', expect: 'table tbody tr', minMatches: 4 },
      { query: '?view=schedules', expect: 'table thead th', minMatches: 4 },
      { query: '?view=mandates', expect: 'table thead th', minMatches: 4 },
    ],
    expect: 'table thead th',
    minMatches: 4,
  },
  {
    path: '/admin/backups',
    variants: [{ query: '', expect: 'table tbody tr', minMatches: 2 }],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/platform',
    variants: [{ query: '', expect: 'main a[href^="/platform/"]', minMatches: 4 }],
    expect: 'main a[href="/platform/organizations"]',
    minMatches: 1,
  },
  {
    path: '/docs',
    // No params, no gates, no database — a second variant would be vacuous.
    variants: [{ query: '', expect: 'a[href^="/docs/"]', minMatches: 20 }],
    expect: 'a[href^="/docs/"]',
    minMatches: 20,
  },
  {
    path: '/property-management',
    // The feature is default-OFF; the fixture turns it on for this tenant, or
    // the harness would compare two error pages.
    variants: [{ query: '', expect: 'table tbody tr, main h1', minMatches: 1 }],
    expect: 'table tbody tr, main h1',
    minMatches: 1,
  },
  {
    path: '/ar',
    // The cockpit body is one client component; the header is a create menu
    // beside the module tabs in one flex wrapper.
    variants: [{ query: '', expect: 'main h1, main h2', minMatches: 1 }],
    expect: 'main h1, main h2',
    minMatches: 1,
  },
  {
    path: '/admin/setup/crm',
    variants: [
      '',
      { query: '?tab=opportunityStatuses', expect: 'table tbody tr', minMatches: 3 },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/admin/apps',
    variants: [
      '',
      { query: '?status=disabled', expect: 'table tbody tr', minMatches: 1 },
      {
        query: '?app=viewspec-demo',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/ap/capture',
    // The list is a widget, not a table block: it owns row selection,
    // per-row checkboxes and three bulk actions.
    variants: [
      '',
      { query: '?status=failed', expect: 'table tbody tr', minMatches: 1 },
      {
        query: '?capture=00000000-0000-7000-9000-000000002001',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/reports/project-profitability',
    // Whole-table widget, and complementary filter bars behind loader flags
    // because the native `sections` control is data-driven.
    variants: [
      '',
      { query: '?q=zzzznomatch', expect: 'main p', minMatches: 1 },
    ],
    expect: 'table tbody tr',
    minMatches: 6,
  },
  {
    path: '/admin/setup/overhead',
    // Four mutually exclusive bodies behind ?view=, one step wider than the
    // accounts page's three.
    variants: [
      '',
      { query: '?view=lifecycle', expect: 'main section h3', minMatches: 1 },
      { query: '?view=application', expect: 'main section h3', minMatches: 1 },
    ],
    expect: 'main h2',
    minMatches: 1,
  },
  {
    path: '/admin/setup/readiness',
    // Seven check cards in a `bare` layout — the setup workspace already
    // draws the shell chrome.
    variants: [{ query: '', expect: 'main a[href^="/admin/setup"]', minMatches: 5 }],
    expect: 'main a[href^="/admin/setup"]',
    minMatches: 5,
  },
  {
    path: '/knowledge/views/01a08739-eb71-714a-bceb-19e015fd17db',
    // A saved view's run page: a permission-gated action cluster in the
    // header, and a body that is an empty paper or a result table.
    variants: [{ query: '', expect: 'main', minMatches: 1 }],
    expect: 'main',
    minMatches: 1,
  },
  {
    path: '/knowledge/views',
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/insights/dashboards',
    // First page with sortable column headers.
    variants: ['', '?sort=name&dir=asc'],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/insights',
    variants: ['', '?sort=name&dir=asc'],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/records/types',
    // Widest use of sorting so far: five of seven columns sort.
    variants: ['', '?sort=records&dir=desc',
      // The flyout is portaled to <body>: without naming that root the
      // comparison never looks at the drawer at all.
      {
        query: '?type=01a0878a-8277-7b16-b64e-ac70ff8445ee',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/compliance/lien-waivers',
    variants: ['', '?direction=received',
      // The flyout is portaled to <body>: without naming that root the
      // comparison never looks at the drawer at all.
      {
        query: '?waiver=01a08793-9f04-7a5f-af67-5ae4be47ce4f',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/compliance/information-returns',
    // Two tables plus a real <section> with heading and prose.
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/platform/access',
    // Uses the `sortable-th` header variant and a server-action control cell.
    // Requires a super-admin session; without one the page redirects to the
    // dashboard and BOTH renders would agree about the wrong page.
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/platform/organizations',
    variants: ['', '?sort=users&dir=desc'],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/platform/users',
    variants: ['', '?sort=lastLogin&dir=desc'],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/platform/email-log',
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/compliance/vendors',
    // A matrix: columns come from data, so the grid is a domain component.
    variants: ['', '?state=attention'],
    expect: 'table tbody tr',
    minMatches: 4,
  },
  {
    path: '/admin/setup/segment-definitions',
    // The setup workspace: `layout: 'bare'` (its own shell already draws the
    // header chrome), a composed heading, and the widest column-kind coverage
    // the sim org offers. The no-match search asserts the in-table empty row.
    variants: [
      '',
      '?showInactive=true',
      { query: '?q=zzzznomatch', expect: 'table thead th', minMatches: 5 },
      {
        query: '?row=01a083e6-dc88-7bb5-9a76-1423b1105e4b',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/admin/flows',
    // One flow in the tenant. The two filter variants each round-trip to that
    // same row, which is the honest set here — a bogus-subject variant would
    // render a zero-row table, but with one flow there is nothing else to pin.
    variants: ['', '?subject=vendor_bill', '?q=vendor+bill+approval'],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/admin/setup/labor-costing',
    variants: [
      '',
      { query: '?view=components', expect: 'main section h3', minMatches: 1 },
      {
        query: '?rate=new',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'main h2',
    minMatches: 1,
  },
  {
    path: '/admin/setup/labor-pricing',
    // Two active books, one expired: every variant renders a different set.
    variants: [
      '',
      { query: '?time=expired', expect: 'table tbody tr', minMatches: 1 },
      { query: '?dimension=unscoped', expect: 'table tbody tr', minMatches: 1 },
      {
        query: '?card=00000000-0000-7000-9000-000000008811',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/admin/setup/payroll',
    variants: [
      { query: '', expect: 'main h2, main h3', minMatches: 2 },
      { query: '?tab=schedules', expect: 'table tbody tr', minMatches: 2 },
      { query: '?tab=components', expect: 'table thead th', minMatches: 1 },
      { query: '?tab=accounts', expect: 'main h3', minMatches: 1 },
      { query: '?tab=ca', expect: 'main h3', minMatches: 1 },
      { query: '?tab=zzzznomatch', expect: 'main h2, main h3', minMatches: 2 },
    ],
    expect: 'main h2, main h3',
    minMatches: 2,
  },
  {
    path: '/payroll/runs/00000000-0000-7000-9000-000000001811',
    // A calculated run: the loader derives step `review`, so the stub table
    // renders on load; `?step=readiness` forces a disjoint step body.
    variants: [
      { query: '', expect: 'main table tbody tr', minMatches: 2 },
      { query: '?step=readiness', expect: 'main ul li', minMatches: 1 },
    ],
    expect: 'main table tbody tr',
    minMatches: 2,
  },
  {
    path: '/banking/psp-settlements',
    // Two draft batches. Only drafts exist by design — see the fixture note:
    // a posted or void batch needs a real journal entry behind it.
    variants: [{ query: '', expect: 'table tbody tr', minMatches: 2 }],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/banking/match',
    // Two real branches: no account chosen (the picker alone) and an account
    // with an open reconciliation (the three-list workspace).
    variants: [
      { query: '', expect: 'main select, main button', minMatches: 1 },
      { query: '?account=a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e', expect: 'main select, main button', minMatches: 1 },
    ],
    expect: 'main select, main button',
    minMatches: 1,
  },
  {
    path: '/payroll',
    variants: [''],
    expect: 'h2, h3',
    minMatches: 4,
  },
  {
    path: '/compliance',
    // One variant only: the tenant has no 1099 data, so `?year=` changes
    // nothing and the second render was byte-identical — which the
    // identical-markup guard rightly refused.
    variants: [''],
    expect: 'main section li',
    minMatches: 4,
  },
  {
    path: '/tax',
    // The prepare tab is a client form; the history tab is a hand-rolled
    // table; the drawer opens a prepared filing with its mark-as-filed form.
    variants: [
      { query: '', expect: 'main select, main input', minMatches: 1 },
      { query: '?tab=history', expect: 'table tbody tr', minMatches: 3 },
      { query: '?tab=history&status=filed', expect: 'table tbody tr', minMatches: 1 },
      {
        query: '?tab=history&filing=00000000-0000-7000-9000-000000006811',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'main select, main input',
    minMatches: 1,
  },
  {
    path: '/banking/transactions',
    variants: [
      '',
      {
        query: '?doc=00000000-0000-7000-9000-000000000501',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/admin/build',
    variants: [{ query: '', expect: 'section a', minMatches: 8 }],
    expect: 'section a',
    minMatches: 8,
  },
  {
    path: '/platform/users/01a08426-0962-74c7-a086-e1609c589dcb',
    // A detail page whose every control is a bound SERVER ACTION, so each one
    // is a widget that takes ids and binds the action itself.
    variants: [{ query: '', expect: 'main h2', minMatches: 1 }],
    expect: 'main h2',
    minMatches: 1,
  },
  {
    path: '/admin/roles',
    // The hand-rolled role table as a widget; header, search, type chips,
    // empty state and pager are ordinary spec.
    variants: [
      '',
      '?sort=members&dir=desc',
      { query: '?type=custom', expect: 'main h3', minMatches: 1 },
      { query: '?q=zzzznomatch', expect: 'main h3', minMatches: 1 },
    ],
    expect: 'table tbody tr',
    minMatches: 7,
  },
  {
    path: '/admin/audit',
    variants: [
      '',
      '?action=post',
      // No system-actor rows in the tenant: this pins the empty branch.
      { query: '?actor=system', expect: 'main h3', minMatches: 1 },
      '?from=2026-09-08&to=2026-09-08',
      {
        query: '?event=01a083e7-3bb7-7dc6-88e6-dcf4e53e8270',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/banking',
    // A cockpit with no table at all: the assertion counts panel headings,
    // the /purchasing precedent.
    variants: [{ query: '', expect: 'h2, h3', minMatches: 5 }],
    expect: 'h2, h3',
    minMatches: 5,
  },
  {
    path: '/reports',
    // The report launcher. One client component: its cards sit behind a
    // search filter with its own empty state, so a spec-side repeat would
    // render the unfiltered set and strand the input from what it filters.
    variants: [{ query: '', expect: 'main section', minMatches: 5 }],
    expect: 'main section',
    minMatches: 5,
  },
  {
    path: '/analytics',
    // A static launcher: one client component owning its own search and icon
    // maps, placed whole inside the plain page shell.
    variants: [{ query: '', expect: 'section a[href^="/analytics/"]', minMatches: 8 }],
    expect: 'section a',
    minMatches: 8,
  },
  {
    path: '/query',
    // The SQL console. Its whole body is one client workbench, and the page
    // 404s unless the tenant has queryConsole on — which the fixture now sets.
    variants: [{ query: '', expect: 'main h1', minMatches: 1 }],
    expect: 'main h1',
    minMatches: 1,
  },
  {
    path: '/accounting',
    // A cockpit built from stat tiles, a health hero and shared rail panels.
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/customers',
    // A module cockpit: vitals tiles gated per feature, a hero relationships
    // table, and a rail of panels.
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/admin',
    // The admin hub: nested repeats over permission-filtered groups and
    // cards, in a `bare` layout because the hub owns its own shell.
    variants: [{ query: '', expect: 'section a[href="/admin/users"]', minMatches: 1 }],
    expect: 'section a',
    minMatches: 15,
  },
  {
    path: '/admin/users',
    // The table is a widget here (the native page hand-rolls a plain
    // <table>); everything around it — header, search, chips, empty state,
    // pager — is ordinary spec.
    variants: [
      '',
      '?sort=email&dir=desc',
      { query: '?status=inactive', expect: 'main h3, table tbody tr', minMatches: 1 },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/payments',
    // Money out: two exclusive sections behind a pill switch, and a header
    // action that is a conditional PAIR rather than one gated widget.
    // The runs tab has no payment runs in this tenant, so it renders its
    // builder and empty state rather than a table.
    variants: ['', { query: '?view=runs', expect: 'main h3, main h2', minMatches: 1 }],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/receipts',
    // The mirror of /payments through the same two slots, with kind and
    // direction flipped.
    variants: ['', { query: '?view=runs', expect: 'main h3, main h2', minMatches: 1 }],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/documents',
    // The file cabinet: `layout: 'bare'` (it owns its own full-height shell),
    // a folder tree, a selectable file table and two flyouts.
    variants: [
      '',
      { query: '?fid=00000000-0000-7000-9000-000000005801', expect: 'table tbody tr', minMatches: 1 },
      {
        query: '?file=00000000-0000-7000-9000-000000005803',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/banking/cash',
    // The cockpit body is one client component; the horizon param pins the
    // accepted-vs-default-fallback branches.
    variants: ['', { query: '?horizon=4', expect: 'main h1, main h3', minMatches: 4 }],
    expect: 'main h1, main h3',
    minMatches: 4,
  },
  {
    path: '/admin/setup/bank-feeds',
    // Registered only because the fixture turns `bankFeeds` on; without it
    // both paths redirect and the harness would compare two redirects.
    variants: [{ query: '', expect: 'main', minMatches: 1 }],
    expect: 'main',
    minMatches: 1,
  },
  {
    path: '/docs/quick-start',
    variants: [{ query: '', expect: 'main a[href^="/docs/"]', minMatches: 1 }],
    expect: 'main a[href^="/docs/"]',
    minMatches: 1,
  },
  {
    path: '/expenses',
    // Cockpit: 5 vitals tiles, a trend panel, the (empty) approval queue and
    // the categories panel. The Breakdown sub-view is client state.
    variants: [''],
    expect: 'section h3',
    minMatches: 3,
  },
  {
    path: '/ap',
    variants: [{ query: '', expect: 'main h1, main h3', minMatches: 2 }],
    expect: 'main h1, main h3',
    minMatches: 2,
  },
  {
    path: '/collections',
    // Neither subscription feature is on in this tenant, and the recurring
    // and dunning lists fetch client-side and come back empty — so the pinned
    // content is the tab bar, the panel headings and the translated empty
    // rows. No fixture can change that: those rows live behind fetch, not the
    // loader.
    variants: [{ query: '', expect: 'main button, main h3, main td', minMatches: 8 }],
    expect: 'main button',
    minMatches: 3,
  },
  {
    path: '/subcontracts',
    // The register is client-fetched but renders whatever the tenant holds,
    // and the tenant held nothing — fixture …0801-0802 is what makes this
    // comparison mean anything. Tabs and drawers have no URL affordance.
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/documents/trash',
    // Fixture …5811-5814: one trashed folder + one trashed file.
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/data/export',
    // Zero server data: `ExportClient` fetches its own descriptors after
    // mount, so the pin is the static chrome that exists before any fetch.
    variants: [''],
    expect: 'main h1',
    minMatches: 1,
  },
  {
    path: '/data/import',
    // Likewise zero server data. The source-step textarea renders
    // synchronously with no fetch dependency.
    variants: [''],
    expect: 'main textarea',
    minMatches: 1,
  },
  // --- analytics dashboards ---------------------------------------------------
  //
  // Seven pages of one shape: the `analytics-header` frame over one whole
  // client view. The `?period=` variant is the real assertion on each — it
  // proves the loader resolved a DIFFERENT period on the spec path, not just
  // that the widget rendered.
  {
    path: '/analytics/cashflow',
    // These bodies are client tab workspaces and every TABLE lives in a tab
    // that is not mounted by default, so the pin is `main section h3` — the
    // Panel headings the overview tab always renders, which are absent from
    // a body that failed to render at all.
    //
    // 4 / 8 / 12 are the accepted horizons; anything else falls back to 4, so
    // `?horizon=nope` must render byte-identically to the default.
    variants: [
      '',
      { query: '?horizon=12', expect: 'main section h3', minMatches: 4 },
      { query: '?horizon=nope', expect: 'main section h3', minMatches: 4 },
    ],
    expect: 'main section h3',
    minMatches: 4,
  },
  {
    path: '/analytics/financial-health',
    // Ten client tabs, only the first mounted: the pin is the tab strip
    // itself (a button per tab), which is present on every render.
    variants: ['', { query: '?period=last-quarter', expect: 'main button', minMatches: 9 }],
    expect: 'main button',
    minMatches: 9,
  },
  {
    path: '/analytics/utilization',
    variants: ['', { query: '?period=last-quarter', expect: 'main table tbody tr', minMatches: 1 }],
    expect: 'main table tbody tr',
    minMatches: 1,
  },
  {
    path: '/analytics/spend-velocity',
    variants: ['', { query: '?period=last-quarter', expect: 'main table tbody tr', minMatches: 1 }],
    expect: 'main table tbody tr',
    minMatches: 1,
  },
  {
    path: '/analytics/vendor-performance',
    variants: ['', { query: '?period=last-quarter', expect: 'main section h3', minMatches: 3 }],
    expect: 'main section h3',
    minMatches: 3,
  },
  {
    path: '/analytics/customer-intelligence',
    variants: ['', { query: '?period=last-quarter', expect: 'main section h3', minMatches: 2 }],
    expect: 'main section h3',
    minMatches: 2,
  },
  {
    path: '/analytics/sentinel',
    // Full-ledger forensics: gated on an unrestricted subsidiary fence AND
    // admin.audit.read. The harness user holds both.
    variants: ['', { query: '?period=last-quarter', expect: 'main table tbody tr', minMatches: 1 }],
    expect: 'main table tbody tr',
    minMatches: 1,
  },
  {
    path: '/apps/library',
    // Marketplace browser: a card grid over the fixture listings, plus the
    // resultless note. `main code` is the per-card key element, which the
    // note branch never renders; the note title is the `main h2`.
    variants: [
      '',
      { query: '?q=payroll', expect: 'main code', minMatches: 1 },
      { query: '?q=zzzznomatch', expect: 'main h2', minMatches: 1 },
    ],
    expect: 'main code',
    minMatches: 3,
  },
  {
    path: '/admin/setup/tax-depreciation',
    // Tab workspace behind one `?tab=` param. The default and `?tab=bogus`
    // both land on the overview (the native fallback contract, copied
    // verbatim); the entity tabs render through the shared setup-section
    // slot and list the seeded regime / pool class.
    variants: [
      '',
      { query: '?tab=bogus', expect: 'main nav a', minMatches: 4 },
      { query: '?tab=regimes', expect: 'main table tbody tr', minMatches: 1 },
      { query: '?tab=classes', expect: 'main table tbody tr', minMatches: 1 },
    ],
    expect: 'main nav a',
    minMatches: 4,
  },
  {
    path: '/tax/provisions/00000000-0000-7000-9000-000000006901',
    // IAS 12 draft: post button + three temporary differences.
    variants: [{ query: '', expect: 'main table tbody tr', minMatches: 8 }],
    expect: 'main table tbody tr',
    minMatches: 8,
  },
  {
    path: '/tax/provisions/00000000-0000-7000-9000-000000006902',
    // ASC 740 draft with no measured differences: the italic empty note.
    variants: [{ query: '', expect: 'main table tbody tr', minMatches: 3 }],
    expect: 'main table tbody tr',
    minMatches: 3,
  },
  {
    path: '/tax/provisions/00000000-0000-7000-9000-000000006903',
    // Posted run: the post button is gone. Differences cannot be seeded on a
    // finalized run — the history trigger rejects any insert against one — so
    // this variant pins the hidden-button branch, not the difference rows.
    variants: [{ query: '', expect: 'main table tbody tr', minMatches: 4 }],
    expect: 'main table tbody tr',
    minMatches: 4,
  },
  {
    path: '/payroll/parallel-run',
    // One workspace widget: the register/run pickers, the comparisons table
    // and the registers table. The findings drawer is fetch-driven client
    // state, not URL-addressable, so there is no drawer variant.
    variants: [''],
    expect: 'main table tbody tr',
    minMatches: 2,
  },
  {
    path: '/banking/imports',
    // The statements list plus the live-feed panel, which stays one widget
    // because every row of it is a bundle of conditional pairs.
    // No search on this page's list, so no empty-search branch to pin.
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/budgets',
    variants: [
      '',
      {
        query: '?budget=00000000-0000-7000-9000-000000004801',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/payroll/runs',
    // The universal record list over pay_run documents, with a per-row link
    // into the run wizard (a full page, not a drawer).
    variants: ['', { query: '?stage=calculated', expect: 'table tbody tr', minMatches: 1 }],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/field-tickets',
    // The sim tenant has 500 field-ticket DOCUMENTS and no extension rows, so
    // the list's inner join yielded nothing at all until the fixture landed.
    variants: [
      '',
      {
        query: '?ticket=00000000-0000-7000-9000-000000002801',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/banking/rules',
    // Both outcome branches (categorize against a live account, exclude) and
    // both sides of the active filter. The when/outcome columns are prose
    // summaries the slot formats, not registry-typed cells.
    variants: [
      '',
      { query: '?active=false', expect: 'table tbody tr', minMatches: 1 },
      { query: '?q=zzzznomatch', expect: 'main h3', minMatches: 1 },
      {
        query: '?rule=00000000-0000-7000-9000-000000003801',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/entities/customers',
    variants: [
      '',
      {
        query: '?party=1186e699-5da5-466e-8adb-a85ed07a9ee6',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/entities/vendors',
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/timesheets',
    // Entity list over the timesheet_week aggregate plus the WeeklyGrid
    // editor in the drawer slot.
    variants: [
      '',
      '?status=approved',
      {
        query: '?timesheet=044ea4d1-8157-4cb8-93f9-7b70e7ec8f80:2025-12-28',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/items',
    // The catalog list, the re-homed rate-books setup surface, and the flyout.
    variants: [
      '',
      { query: '?view=rate-books', expect: 'table thead th', minMatches: 1 },
      {
        query: '?item=7f1ebdf1-28da-417c-9ed8-73fa1822c07b',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/inventory',
    // Four searchParam-driven bodies: two entity lists, two registry-backed
    // configuration tabs, and the create-movement drawer.
    variants: [
      '',
      { query: '?inventoryView=movements', expect: 'table tbody tr', minMatches: 2 },
      { query: '?inventoryView=locations', expect: 'table tbody tr', minMatches: 1 },
      { query: '?inventoryView=bom', expect: 'table tbody tr', minMatches: 1 },
      {
        query: '?movement=new',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    path: '/crm/activities',
    variants: [
      '',
      {
        query: '?activity=00000000-0000-7000-a000-000000000101',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/crm/opportunities',
    variants: [
      '',
      {
        query: '?opportunity=00000000-0000-7000-a000-000000000001',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/expenses/reports',
    // The universal record list plus per-row expense actions, which ride
    // through the slot as a widget ref rather than a callback.
    variants: [
      '',
      '?status=posted',
      { query: '?q=zzzznomatch', expect: 'table thead th', minMatches: 3 },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/close',
    // The period list. The run branch stays native by design: its wizard is a
    // client shell no page layout covers, and decomposing it would
    // reimplement rather than compose.
    variants: [
      '',
      { query: '?q=2026-02', expect: 'table tbody tr', minMatches: 1 },
      { query: '?status=not_started', expect: 'table tbody tr', minMatches: 3 },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/ap/bills',
    variants: [
      '',
      { query: '?status=posted', expect: 'table tbody tr', minMatches: 3 },
      // A no-match search leaves the record list's table standing with zero
      // rows; the empty STATE belongs to a list with no rows at all.
      { query: '?q=zzzznomatch', expect: 'table thead th', minMatches: 3 },
      {
        query: '?doc=01a083e7-391c-7a04-886f-9bf4cb26b71b',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/purchase-orders',
    variants: [
      '',
      {
        query: '?order=00000000-0000-7000-9000-000000000901',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/sales-orders',
    variants: [
      '',
      {
        query: '?order=00000000-0000-7000-9000-000000000601',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 2,
  },
  {
    path: '/estimates',
    variants: [
      '',
      {
        query: '?estimate=00000000-0000-7000-9000-000000000701',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/journal',
    variants: [
      '',
      {
        query: '?entry=01a083e7-3954-7d4a-b2cc-c6a29f094351',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/assets',
    // No assets in the tenant, so the list renders its empty state; the tax
    // tab is a wholly different body chosen by a presence flag.
    variants: [
      { query: '', expect: 'main h3', minMatches: 1 },
      { query: '?tab=tax-depreciation', expect: 'main select, main input', minMatches: 1 },
    ],
    expect: 'main h3',
    minMatches: 1,
  },
  {
    path: '/crm/forecasts',
    // Three `frame` sections, per-currency KPI groups through repeat, and two
    // tables with presence-flag empty pairs.
    variants: ['', '?owner=68998480-15db-4f5d-bf0b-9e1ef472b0d7'],
    expect: 'section table tbody tr',
    minMatches: 1,
  },
  {
    path: '/ar/invoices',
    // The universal RECORD list (the documents twin of the entity list) plus
    // the document flyout, with per-row actions built from a widget ref.
    variants: [
      '',
      // No credits in the tenant: this pins the EmptyState branch, not a table.
      { query: '?kind=customer_credit', expect: 'main h3', minMatches: 1 },
      {
        query: '?doc=01a083e7-39a0-7f05-b0b9-db3149d75113',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 25,
  },
  {
    path: '/records/site_visit',
    // A tenant-defined record module: its columns come from the type's field
    // definitions, so the table is data-driven on both sides.
    variants: [
      '',
      { query: '?status=active', expect: 'table tbody tr', minMatches: 1 },
      // A search that matches nothing leaves the table standing with zero
      // rows; the empty STATE belongs to a module with no records at all.
      { query: '?q=zzzznomatch', expect: 'table thead th', minMatches: 3 },
    ],
    expect: 'table tbody tr',
    minMatches: 1,
  },
  {
    // Bank account detail: two independent prefixed lists (stmt*, recon*)
    // plus a statement-lines drawer.
    path: '/banking/a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e',
    variants: [
      { query: '', expect: 'table tbody tr', minMatches: 5 },
      { query: '?stmtQ=ofx', expect: 'table tbody tr', minMatches: 4 },
      { query: '?source=csv&stmtSort=imported&stmtDir=asc', expect: 'table tbody tr', minMatches: 4 },
      { query: '?reconStatus=signed_off', expect: 'table tbody tr', minMatches: 4 },
      { query: '?reconSort=balance&reconDir=desc', expect: 'table tbody tr', minMatches: 5 },
      { query: '?stmtQ=zzzznomatch', expect: 'table thead th', minMatches: 7 },
      {
        query: '?statement=00000000-0000-7000-9000-000000000403',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/admin/customization',
    // The unfiltered list hides every record type whose feature is off, so
    // the counts here are what the sim tenant's four enabled features leave
    // visible — 23 forms, 40 org-scope views — not what the tables hold.
    variants: [
      '',
      '?tab=views',
      { query: '?recordType=project', expect: 'table tbody tr', minMatches: 1 },
      { query: '?recordType=project&tab=views', expect: 'table tbody tr', minMatches: 1 },
    ],
    expect: 'table tbody tr',
    minMatches: 20,
  },
  {
    path: '/projects',
    // Nearly all entity list; what is page-specific is a drawer slot the
    // native page fills with a fragment of up to three components.
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/approvals',
    // Three tabs over the Flows engine, and the first page to use a `frame`
    // (its body is wrapped in TabContent, a component rather than a div).
    variants: [
      '',
      { query: '?tab=submitted', expect: 'table tbody tr', minMatches: 3 },
      { query: '?tab=all', expect: 'table tbody tr', minMatches: 3 },
      { query: '?kind=vendor_bill', expect: 'table tbody tr', minMatches: 3 },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/accounts',
    // Three mutually exclusive bodies: the customizable entity list, flat
    // search results, and the class hierarchy.
    variants: [
      '',
      { query: '?layout=hierarchy', expect: 'table tbody tr', minMatches: 10 },
      { query: '?layout=hierarchy&q=account', expect: 'table tbody tr', minMatches: 2 },
      { query: '?layout=hierarchy&class=income', expect: 'table tbody tr', minMatches: 2 },
      // The account flyout, opened from the entity-list layout — the one place
      // the drawer is rendered BY the list rather than beside it.
      {
        query: '?account=a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/continuous-close',
    // Two independent lists behind a tab, each with its own pager.
    variants: [
      '',
      { query: '?severity=critical', minMatches: 2 },
      { query: '?tab=reports', expect: 'section h2', minMatches: 1 },
      // Both flyouts: the findings drawer and the narrative drawer.
      {
        query: '?item=00000000-0000-7000-9000-000000000101',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
      {
        query: '?tab=reports&report=00000000-0000-7000-9000-000000000002',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/parties',
    variants: [
      '',
      '?role=vendor',
      '?sort=code&dir=desc',
      // The flyout path. The id is a sim-org party — the whole harness is
      // pinned to that tenant already — and it is here because the drawer is
      // the one place the party spec carries a remount key.
      {
        query: '?role=vendor&party=96c6a13b-5ae5-4627-b56a-1fc2c5bec9fc',
        expect: '[data-drawer-layer]',
        minMatches: 1,
        // The flyout is portaled to <body>, so it has to be named explicitly
        // or the comparison never looks at it.
        scopes: ['main', '[data-drawer-layer]'],
      },
    ],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/custom',
    variants: ['', '?sort=kind&dir=desc'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/purchasing',
    variants: [''],
    // The cockpit's hero panel — proves the grid/panel composition rendered,
    // not just the page shell.
    expect: 'h2, h3',
  },
]

function specUrl(path, variant) {
  const separator = variant.includes('?') ? '&' : '?'
  return `${BASE}${path}${variant}${separator}__viewspec=1`
}

async function login(page) {
  const response = await page.request.post(`${BASE}/api/login`, {
    headers: { 'content-type': 'application/json', origin: BASE, referer: `${BASE}/login` },
    data: { email: EMAIL, password: PASSWORD },
  })
  if (!response.ok()) throw new Error(`login failed: ${response.status()} ${await response.text()}`)
}

/**
 * Navigate and wait until the page has genuinely settled: streaming finished,
 * no suspense fallback left, network quiet, and the mount fade complete. The
 * fade matters because `PageContainer` animates opacity on mount; screenshotting
 * mid-animation produces a diff that is pure timing noise.
 */
async function renderSettled(page, url, expectSelector, minMatches = 0) {
  // `domcontentloaded`, not `networkidle`: a large page with many client
  // components (a register with thousands of transaction links) never reaches
  // network idle within any sane timeout, while serving in ~60ms. Readiness is
  // asserted explicitly below — suspense drained, content selector visible,
  // overlays cleared — which is stricter than idle anyway.
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // Fail on the status rather than on a downstream selector timeout. A server
  // error still renders an app shell with a <main>, so without this check a
  // 500 costs a 30s timeout and reports as a missing selector instead of as
  // what it is. (A missing message key produced exactly that.)
  if (response && response.status() >= 400) {
    throw new Error(`${url} returned HTTP ${response.status()} — the page failed to render`)
  }
  await page.waitForSelector('main', { state: 'attached' })
  // Suspense fallbacks leave `<template id="B:n">` placeholders behind.
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main')
      return !!main && !main.querySelector('template[id^="B:"]')
    },
    { timeout: 30_000 },
  )
  // The positive assertion. `textContent.length > 0` is not enough — the
  // loading screen satisfies it — so each page names an element that only
  // exists once its real content has rendered.
  if (expectSelector) {
    await page.waitForSelector(expectSelector, { state: 'visible', timeout: 30_000 })
  }
  // A page that legitimately renders its EMPTY state is not blank, so the ink
  // and byte-count guards pass it happily while proving nothing about the
  // table path. `minMatches` demands real content: import history passed at
  // 2068 bytes with zero rows before this existed.
  if (expectSelector && minMatches > 0) {
    // WAIT for the count, do not sample it once. A table filled by a client
    // fetch after mount reaches one row before it reaches all of them, and a
    // single sample failed a page that was merely still arriving. The wait is
    // bounded, so a page that genuinely has too few rows still fails — just
    // for the right reason.
    let found = 0
    const deadline = Date.now() + 15_000
    for (;;) {
      found = await page.locator(expectSelector).count()
      if (found >= minMatches || Date.now() > deadline) break
      await page.waitForTimeout(250)
    }
    if (found < minMatches) {
      throw new Error(
        `${url} matched ${found} of "${expectSelector}", need ${minMatches} — the page has no data, so this comparison would prove nothing`,
      )
    }
  }
  // Wait out the brand splash. It is a root-layout overlay held for
  // MIN_VISIBLE_MS (2s) plus a 400ms fade on EVERY document load, so a capture
  // taken before it clears photographs the splash instead of the page — which
  // is identical on both sides and passes a pixel comparison meaninglessly.
  // Matching any full-viewport fixed overlay rather than the splash's own
  // classes keeps this correct if another overlay is introduced later.
  //
  // Waited for by its own marker rather than by "any full-viewport fixed
  // overlay": a flyout scrim matches that shape too and never clears, so the
  // generic form hung every drawer variant. The splash unmounts itself, so
  // absence of the node is the settled state.
  await page.waitForFunction(() => !document.querySelector('[data-splash-root]'), {
    timeout: 30_000,
  })
  await page.evaluate(() => document.fonts?.ready)

  // Capture what each control ACTUALLY holds, then let the residue go.
  //
  // React drives a controlled <select> through its `value` PROPERTY, which
  // never appears in markup, while the `selected` attribute its SSR <option>
  // carried is vestigial and gets removed at an unpredictable point during
  // hydration. Comparing the residue is a coin flip — observed flipping
  // direction between runs on the same page. Stamping the live value as an
  // attribute makes the real selection comparable for the first time, which
  // is why dropping `selected` afterwards strengthens the check rather than
  // loosening it.
  // Document-wide, not `main`-scoped: a drawer portals to <body>, so scoping
  // the stamp to <main> left every control inside a flyout un-stamped and
  // still carrying the coin-flip `selected` residue.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('select')) {
      el.setAttribute('data-selected-value', el.value)
    }
    for (const el of document.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
      el.setAttribute('data-checked', String(el.checked))
    }
  })

  // Wait for the DOM to STOP changing before reading it.
  //
  // React hydration rewrites parts of the server markup — most visibly, a
  // controlled <select> loses the `selected` attribute its SSR <option> was
  // rendered with. Reading mid-hydration produces a difference that is pure
  // timing: the same page compared against itself would fail. Polling until two
  // consecutive reads match fixes the whole class rather than normalizing away
  // one symptom, which would risk hiding a genuinely wrong selection.
  let previous = ''
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await page.evaluate(() => document.body.innerHTML)
    if (current === previous) return
    previous = current
    await page.waitForTimeout(150)
  }
}

/**
 * Screenshot the resting state.
 *
 * NOT `animations: 'disabled'`: that rewinds finite animations to their first
 * frame, and this app's entrance animations start at opacity 0, so it renders
 * a blank page — identically blank on both sides, which passes a pixel
 * comparison while proving nothing. Instead let entrance animations finish,
 * then hard-stop everything still moving. The brand logo runs an infinite
 * 12s stroke-redraw cycle; `animation: none` drops it to its resting fully
 * drawn state, which is deterministic.
 */
async function captureSettled(page) {
  await page.waitForTimeout(900)
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el)
      if (parseFloat(style.opacity) < 1) el.style.opacity = '1'
      if (style.transform !== 'none') el.style.transform = 'none'
    }
  })
  // Drop focus before photographing.
  //
  // A flyout autofocuses its first control, and Chrome paints the ring only
  // when it considers focus keyboard-driven — which depends on the
  // interaction history of the load, so the SAME page photographed twice
  // disagrees about the ring. It cost an 860px diff on a variant whose DOM
  // matched exactly (focus is not in the DOM, so the structural gate cannot
  // see it either way). Blurring removes the state from both captures rather
  // than raising the tolerance until the noise fits under it.
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.waitForTimeout(120)
  // Screenshot <main>, not the full page: the structural diff is scoped to
  // <main>, and the shell around it (top nav, sidebar) is identical by
  // construction. Including it only contributes font-antialiasing noise from a
  // region that is not under test — 352 stray pixels on the api-keys page,
  // well past a tolerance tuned for content.
  return await page.locator('main').screenshot({ caret: 'hide' })
}

function normalize(markup) {
  return (
    markup
      // React suspense / segment comment markers.
      .replace(/<!--[\s\S]*?-->/g, '')
      // useId values depend on tree position and never reach the user. Two
      // shapes: React 18's «…» and React 19's _R_…_ / _r_…_. Only ever
      // stripped from the attributes that carry them, and only wholesale —
      // a mismatched PAIR (a label pointing at nothing) would still show as a
      // structural difference because the attribute itself would be absent on
      // one side.
      .replace(
        /\b(id|for|aria-labelledby|aria-controls|aria-describedby)="[^"]*(«[^"]*»|_[Rr]_[a-z0-9]*_)[^"]*"/g,
        '',
      )
      // The same values also appear inside SVG `url(#…)` references — a
      // gradient's id, pointed at by `stroke`/`fill`. Rewritten to a constant
      // rather than dropped, so a reference that goes MISSING on one side
      // still shows as a difference.
      .replace(/url\(#[^)]*(«[^)]*»|_[Rr]_[a-z0-9]*_)[^)]*\)/g, 'url(#generated)')
      // ECharts stamps each chart with a per-instance counter/timestamp. Same
      // class of framework noise as useId: generated per mount, never rendered.
      .replace(/ _echarts_instance_="[^"]*"/g, '')
      // The conversion flag leaks into client-built self-referential hrefs
      // (ReportDrillLink rebuilds the query from useSearchParams). It is
      // harness scaffolding that disappears when the native branch is deleted,
      // so removing it is honest — but it has to be removed as a query
      // PARAMETER, preserving the `?`/`&` separator structure, and `&` arrives
      // entity-encoded inside an attribute value.
      .replace(/\?__viewspec=1(&amp;|&)/g, '?')
      .replace(/(&amp;|&)__viewspec=1/g, '')
      .replace(/\?__viewspec=1/g, '')
      // …and again URL-ENCODED, because links that carry a return path embed
      // the current query inside a parameter value (drawerReturn=%2F…%3F…).
      .replace(/%3F__viewspec%3D1(%26)/gi, '%3F')
      .replace(/%26__viewspec%3D1/gi, '')
      .replace(/%3F__viewspec%3D1/gi, '')
      // A measured wall-clock the page renders honestly. Sentinel times its
      // own forensic sweep and prints "… in 0.1s — no caps or date-range
      // limits", so two renders of the same page differ by construction. This
      // is the one thing in the app a render-diff harness structurally cannot
      // compare, and deleting the feature to make the test pass would be the
      // tail wagging the dog. Normalized to a constant, narrowly: only a bare
      // "in N.Ns" reading, which is the exact shape both `banner.stats` and
      // `coverage.outro` interpolate. A duration that goes MISSING on one side
      // still shows as a difference.
      .replace(/\bin \d+\.\ds\b/g, 'in 0.0s')
      // Vestigial post-hydration; the live value is stamped above.
      .replace(/ selected=""/g, '')
      .replace(/>\s+</g, '><')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * Sort attributes within each tag.
 *
 * Attribute ORDER carries no meaning in HTML and is not user-visible, but
 * React's hydration writes some attributes in a different sequence than the
 * server did (a controlled `<input>` gets `type` reapplied before `value`),
 * so two identical renders can serialize differently purely by timing. Sorting
 * removes that noise without hiding anything real: attribute presence and
 * every value are preserved exactly, so a genuinely different class list, a
 * missing attribute, or a changed value still fails.
 */
function sortAttributes(markup) {
  return markup.replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)+)\s*(\/?)>/g, (_all, tag, attrs, selfClose) => {
    const pairs = attrs.match(/[^\s=]+(?:="[^"]*")?/g) ?? []
    pairs.sort()
    return `<${tag}${pairs.length ? ' ' + pairs.join(' ') : ''}${selfClose}>`
  })
}

/**
 * Sort the class list inside every class attribute.
 *
 * Utility ORDER in the attribute does not affect what Tailwind renders —
 * precedence comes from the order utilities are defined in the compiled CSS,
 * not from the order they appear on the element. So two elements with the same
 * SET of classes are visually identical, and comparing them as ordered strings
 * would fail on nothing but authoring sequence. Sorting preserves the set
 * exactly, so a missing or extra class still fails.
 */
function sortClassLists(markup) {
  return markup.replace(/class="([^"]*)"/g, (_all, classes) => {
    const sorted = classes.trim().split(/\s+/).filter(Boolean).sort().join(' ')
    return `class="${sorted}"`
  })
}

/**
 * Canonicalize inline style attributes.
 *
 * The same declarations serialize two ways depending on how they were set:
 * framer-motion's SSR output is `opacity:1;transform:none`, while a style the
 * browser has since written through the CSSOM comes back as
 * `opacity: 1; transform: none;`. Which one you get depends on whether a row's
 * entrance animation had finished at read time — a race, not a difference.
 *
 * Declarations are preserved exactly; only spacing, trailing semicolons and
 * order are normalized, so a changed or missing property still fails.
 */
function normalizeStyles(markup) {
  return markup.replace(/style="([^"]*)"/g, (_all, style) => {
    const declarations = style
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const index = d.indexOf(':')
        if (index === -1) return d
        const property = d.slice(0, index).trim()
        // Canonicalize the VALUE's incidental spelling, not its meaning.
        //
        // The same declaration serializes two ways depending on whether the
        // browser has round-tripped it through the CSSOM yet: `transition`
        // regains its default `all` property and loses the spaces inside
        // `cubic-bezier(…)`. Two renders of one component disagreed on
        // exactly that and on nothing else. Collapsing whitespace and
        // dropping a leading `all ` from a transition compares the rule
        // rather than the spelling; any real difference in duration, easing
        // or property still shows.
        let value = d.slice(index + 1).trim().replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ')
        // A hex colour and its rgb() form are the same colour: the CSSOM
        // re-serializes `#10b981` as `rgb(16, 185, 129)` once it has
        // round-tripped the declaration, and two renders of one component
        // disagreed on exactly that. Canonicalize to rgb() so the COLOUR is
        // compared rather than its spelling — a different colour still
        // produces a different triple.
        value = value.replace(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi, (hex, digits) => {
          const full =
            digits.length === 3
              ? digits
                  .split('')
                  .map((c) => c + c)
                  .join('')
              : digits
          const n = Number.parseInt(full, 16)
          return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`
        })
        if (property === 'transition') value = value.replace(/^all /, '')
        // Numbers in a style value are rounded to the precision the browser
        // itself keeps. `width:14.285714285714286%` survives verbatim in
        // server markup, but once React writes the same value through the
        // CSSOM Chrome hands it back as `14.2857%` — the same width, spelled
        // shorter. Six significant digits is Chrome's own cut, so this
        // compares the value while leaving any genuinely different one
        // different.
        value = value.replace(/-?\d+\.\d{7,}/g, (n) => String(Number(Number(n).toPrecision(6))))
        return `${property}:${value}`
      })
      .sort()
    return `style="${declarations.join(';')}"`
  })
}

function tokenize(markup) {
  return markup.match(/<[^>]+>|[^<]+/g) ?? []
}

function firstDifference(a, b) {
  const ta = tokenize(a)
  const tb = tokenize(b)
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (ta[i] !== tb[i]) {
      return {
        index: i,
        context: ta.slice(Math.max(0, i - 5), i).join(''),
        native: ta[i] ?? '(end of document)',
        spec: tb[i] ?? '(end of document)',
      }
    }
  }
  return null
}

/**
 * Guard against the failure mode that produced the first false pass: if the
 * two variants of a page render byte-identical content, the harness is very
 * likely comparing chrome rather than content. Report it rather than counting
 * a pass.
 */
function assertVariantsDiffer(results) {
  const withContent = results.filter((r) => r.ok && r.markup)
  const distinct = new Set(withContent.map((r) => r.markup))
  if (withContent.length > 1 && distinct.size === 1) {
    return `every variant rendered identical markup (${withContent[0].markup.length} bytes) — the harness is probably not capturing page content`
  }
  return null
}

/**
 * Confirm the page actually took the branch we think it did.
 *
 * The converted page emits `<meta name="x-viewspec-render">` on the spec path
 * only, hoisted into <head> and therefore outside the compared <main>. Without
 * this check a server still running a build that predates the conversion would
 * serve the native page for BOTH urls and the harness would report a perfect
 * pass — which is exactly what happened before it existed.
 */
async function renderPath(page) {
  return await page.evaluate(() =>
    document.querySelector('meta[name="x-viewspec-render"]') ? 'viewspec' : 'native',
  )
}

/**
 * The stylesheet must actually load. A pixel comparison between two UNSTYLED
 * pages passes trivially, so an app rendering without CSS invalidates the
 * visual half of every result.
 */
async function assertStylesLoaded(page) {
  const status = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="stylesheet"]')
    if (!link) return 'no-stylesheet-link'
    const res = await fetch(link.href)
    if (!res.ok) return `stylesheet ${res.status}`
    const text = await res.text()
    // A real Tailwind build defines the utilities the app is written in.
    return /\.flex\b/.test(text) && /\.text-sm\b/.test(text) ? 'ok' : 'stylesheet-missing-utilities'
  })
  if (status !== 'ok') throw new Error(`styles not loaded: ${status}`)
}


/**
 * Reject a capture that is essentially empty.
 *
 * This harness has produced three false passes, and every one shared a shape:
 * both sides rendered the SAME nothing (a streaming fallback, a stale build,
 * an animation rewound to opacity 0) and the comparison happily reported a
 * match. A pixel comparison cannot tell "identical" from "identically blank",
 * so the content has to be asserted independently of the diff.
 *
 * A real page is mostly background with text, rules and chrome over it. Well
 * under 1% non-background means the capture is a loading screen.
 */
/**
 * Count differing pixels between two captures.
 *
 * Byte equality is too strict: subpixel text antialiasing varies by a handful
 * of pixels between two renders of identical markup. A tolerance is dangerous
 * in principle — it is exactly the mechanism that hides real differences — so
 * it is bounded three ways: the DOM must already match exactly (structure is
 * the real gate, pixels are the backstop), the budget is a few tens of pixels
 * out of ~1.3M, and the actual count is ALWAYS printed on success so a slow
 * creep upward is visible rather than silent.
 */
async function pixelDiff(a, b) {
  const [ra, rb] = await Promise.all([
    sharp(a).raw().toBuffer({ resolveWithObject: true }),
    sharp(b).raw().toBuffer({ resolveWithObject: true }),
  ])
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) {
    return { differing: Infinity, reason: `size ${ra.info.width}x${ra.info.height} vs ${rb.info.width}x${rb.info.height}` }
  }
  const { width, height, channels } = ra.info
  let differing = 0
  for (let i = 0; i < width * height * channels; i += channels) {
    if (ra.data[i] !== rb.data[i] || ra.data[i + 1] !== rb.data[i + 1] || ra.data[i + 2] !== rb.data[i + 2]) {
      differing++
    }
  }
  return { differing, total: width * height }
}

/**
 * Visual tolerance, as a fraction of the compared area.
 *
 * Calibrated against evidence rather than taste. Six real defects have been
 * caught by this harness — a stray wrapper element, money cells losing
 * `tabular-nums`, a closing balance losing its negative tone, a missing header
 * wrapper, a missing layout class, an empty header cell — and the STRUCTURAL
 * diff caught every one of them. The visual diff caught none: on several it
 * reported "match" while the DOM differed. Its only independent findings have
 * been rasterization noise.
 *
 * So structure is the gate and pixels are a coarse backstop for layout shifts
 * the DOM cannot show. Chrome rasterizes identical text slightly differently
 * between loads — sub-pixel glyph positioning, deltas up to ~64 on a few
 * hundred pixels — and a threshold tight enough to reject that rejects
 * correct pages. A genuine layout shift moves thousands of pixels and still
 * fails comfortably.
 */
const PIXEL_TOLERANCE_RATIO = 0.0005
const PIXEL_TOLERANCE_MIN = 64

function pixelTolerance(total) {
  return Math.max(PIXEL_TOLERANCE_MIN, Math.round((total ?? 0) * PIXEL_TOLERANCE_RATIO))
}

async function assertNotBlank(shot, label) {
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
  const counts = new Map()
  const total = info.width * info.height
  for (let i = 0; i < data.length; i += info.channels) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let dominant = 0
  for (const n of counts.values()) if (n > dominant) dominant = n
  const inkRatio = 1 - dominant / total
  if (inkRatio < 0.01) {
    throw new Error(
      `${label} capture is blank (${(inkRatio * 100).toFixed(2)}% non-background) — the page had not rendered`,
    )
  }
  return inkRatio
}

/**
 * Read every compared region as one string.
 *
 * `main` is the default and covers ordinary page content, but a drawer is
 * portaled to <body> and therefore sits OUTSIDE it — comparing only `main`
 * would have reported a flyout variant as passing while never looking at the
 * flyout. A page that opens one names the extra root explicitly.
 */
async function scopedMarkup(page, scopes) {
  const parts = []
  for (const selector of scopes) {
    const count = await page.locator(selector).count()
    if (count === 0) throw new Error(`compared region "${selector}" is not present`)
    parts.push(`<!--scope:${selector}-->` + (await page.locator(selector).first().innerHTML()))
  }
  return parts.join('\n')
}

async function checkVariant(page, path, variant, expectSelector, minMatches, scopes = ['main']) {
  const nativeUrl = `${BASE}${path}${variant}`
  await renderSettled(page, nativeUrl, expectSelector, minMatches)
  await assertStylesLoaded(page)
  const nativePath = await renderPath(page)
  if (nativePath !== 'native') throw new Error(`${nativeUrl} rendered via ${nativePath}, expected native`)
  const nativeMarkup = normalizeStyles(sortClassLists(sortAttributes(normalize(await scopedMarkup(page, scopes)))))
  const nativeShot = await captureSettled(page)
  const ink = await assertNotBlank(nativeShot, `${path}${variant} native`)

  await renderSettled(page, specUrl(path, variant), expectSelector, minMatches)
  const chosen = await renderPath(page)
  if (chosen !== 'viewspec') {
    throw new Error(
      `${specUrl(path, variant)} rendered via ${chosen}, expected viewspec — the server is probably serving a build that predates the conversion`,
    )
  }
  const specMarkup = normalizeStyles(sortClassLists(sortAttributes(normalize(await scopedMarkup(page, scopes)))))
  const specShot = await captureSettled(page)
  await assertNotBlank(specShot, `${path}${variant} spec`)

  const slug = `${path}${variant}`.replace(/[^a-z0-9]+/gi, '_')
  const pixels = nativeShot.equals(specShot) ? { differing: 0, total: 0 } : await pixelDiff(nativeShot, specShot)
  const tolerance = pixelTolerance(pixels.total)
  const pixelsEqual = pixels.differing <= tolerance

  if (nativeMarkup === specMarkup && pixelsEqual) {
    return {
      ok: true,
      path,
      variant,
      bytes: nativeMarkup.length,
      markup: nativeMarkup,
      ink,
      pixels: pixels.differing,
      tolerance,
    }
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, `${slug}.native.html`), nativeMarkup)
  writeFileSync(join(OUT_DIR, `${slug}.spec.html`), specMarkup)
  writeFileSync(join(OUT_DIR, `${slug}.native.png`), nativeShot)
  writeFileSync(join(OUT_DIR, `${slug}.spec.png`), specShot)

  return {
    ok: false,
    path,
    variant,
    slug,
    structural: nativeMarkup === specMarkup,
    visual: pixelsEqual,
    pixels: pixels.differing,
    tolerance,
    diff: nativeMarkup === specMarkup ? null : firstDifference(nativeMarkup, specMarkup),
  }
}

async function main() {
  // Any number of paths may be named; none means every registered page.
  const only = process.argv.slice(2)
  const pages = only.length ? PAGES.filter((p) => only.includes(p.path)) : PAGES
  if (pages.length !== (only.length || PAGES.length)) {
    const missing = only.filter((path) => !PAGES.some((p) => p.path === path))
    console.error(`no registered page matches ${missing.join(', ')}`)
    process.exit(2)
  }

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.VIEWSPEC_HEADED !== '1',
  })
  let failures = 0
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
    const page = await context.newPage()
    await login(page)

    for (const entry of pages) {
      const results = []
      for (const raw of entry.variants) {
        // A variant may be a bare query string, or an object overriding the
        // page's expectations — an intentional empty-result case has to opt out
        // of the data-presence requirement rather than weaken it for everyone.
        const variant = typeof raw === 'string' ? raw : raw.query
        const expect = (typeof raw === 'string' ? undefined : raw.expect) ?? entry.expect
        const minMatches =
          typeof raw === 'string' ? (entry.minMatches ?? 0) : (raw.minMatches ?? entry.minMatches ?? 0)
        let result
        try {
          const scopes =
            (typeof raw === 'string' ? undefined : raw.scopes) ?? entry.scopes ?? ['main']
          result = await checkVariant(page, entry.path, variant, expect, minMatches, scopes)
        } catch (error) {
          failures += 1
          console.error(`✗ ${entry.path}${variant}\n    ${error.message}`)
          continue
        }
        results.push(result)
        if (result.ok) {
          console.log(
          `✓ ${entry.path}${variant || ' (default)'}  [${result.bytes} bytes, ${result.pixels === 0 ? 'pixels identical' : `${result.pixels} px AA`}, ${(result.ink * 100).toFixed(1)}% ink]`,
        )
          continue
        }
        failures += 1
        console.error(`✗ ${entry.path}${variant || ' (default)'}`)
        console.error(`    structural: ${result.structural ? 'match' : 'DIFFER'}   visual: ${result.visual ? 'match' : `DIFFER (${result.pixels} px, tolerance ${result.tolerance})`}`)
        if (result.diff) {
          console.error(`    first difference at node ${result.diff.index}, after: …${result.diff.context.slice(-140)}`)
          console.error(`    native: ${String(result.diff.native).slice(0, 220)}`)
          console.error(`    spec  : ${String(result.diff.spec).slice(0, 220)}`)
        }
        console.error(`    artifacts: ${join(OUT_DIR, `${result.slug}.*`)}`)
      }
      const suspicious = assertVariantsDiffer(results)
      if (suspicious) {
        failures += 1
        console.error(`✗ ${entry.path}: ${suspicious}`)
      }
    }
  } finally {
    await browser.close()
  }

  console.log(failures === 0 ? '\nconformance: PASS' : `\nconformance: FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
