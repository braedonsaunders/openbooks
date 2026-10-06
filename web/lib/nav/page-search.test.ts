import assert from 'node:assert/strict'
import test from 'node:test'
import type { SidebarNavGroup } from '../../components/sidebar-nav'
import { buildPageIndex, searchPages } from './page-search.ts'

const MENU: SidebarNavGroup[] = [
  {
    id: 'accounting',
    label: 'Accounting',
    iconKey: 'book',
    groupHref: '/accounting',
    items: [
      { href: '/journal', label: 'Journal Entries', iconKey: 'book' },
      { href: '/close', label: 'Period Close', iconKey: 'lock', subgroup: 'Close', subgroupHref: '/close/hub' },
    ],
  },
  {
    id: 'hrm',
    label: 'People',
    iconKey: 'users',
    items: [{ href: '/payroll/runs', label: 'Payroll', iconKey: 'wallet' }],
  },
  {
    id: 'operations',
    label: 'Operations',
    iconKey: 'grid',
    items: [{ href: '/banking/feeds', label: 'Bank Connections', iconKey: 'bank' }],
  },
]

const TABS = [
  [
    { href: '/payroll/runs', label: 'Pay Runs' },
    { href: '/payroll/settings', label: 'Settings' },
  ],
  [{ href: '/admin/setup?tab=tax', label: 'Settings' }],
]

const index = buildPageIndex(MENU, TABS)
const hrefs = (query: string) => searchPages(index, query).map((hit) => hit.href)

test('menu entries, sub-menu homes and workspace homes are all searchable pages', () => {
  assert.deepEqual(hrefs('journal'), ['/journal'])
  assert.deepEqual(hrefs('close'), ['/close/hub', '/close'])
  assert.deepEqual(hrefs('accounting'), ['/accounting'], 'a workspace name finds its home, not every page under it')
})

test('a renamed menu entry is found by its displayed name only', () => {
  assert.deepEqual(hrefs('bank connections'), ['/banking/feeds'])
  assert.deepEqual(hrefs('bank feeds'), [])
})

test('a page the resolved menu does not contain is never offered', () => {
  const restricted = buildPageIndex(MENU.filter((group) => group.id !== 'hrm'), [])
  assert.deepEqual(searchPages(restricted, 'payroll'), [])
})

test('workspace tabs carry the menu trail of the entry that opens them', () => {
  const settings = searchPages(index, 'settings')
  assert.deepEqual(settings.map((hit) => [hit.href, hit.trail.join(' › ')]), [
    ['/payroll/settings', 'People › Payroll'],
    ['/admin/setup?tab=tax', ''],
  ])
  assert.deepEqual(hrefs('payroll settings'), ['/payroll/settings'], 'trail words narrow a generic tab name')
})

test('a tab that is also a menu entry appears once, under its menu name', () => {
  const payroll = searchPages(index, 'payroll')
  assert.equal(payroll.filter((hit) => hit.href === '/payroll/runs').length, 1)
  assert.equal(payroll.find((hit) => hit.href === '/payroll/runs')?.title, 'Payroll')
})

test('ranking prefers an exact name, then a prefix, then a word inside the name', () => {
  const menu: SidebarNavGroup[] = [{
    id: 'g',
    label: 'Group',
    iconKey: 'grid',
    items: [
      { href: '/a', label: 'Vendor Invoices', iconKey: 'grid' },
      { href: '/b', label: 'Invoices to Approve', iconKey: 'grid' },
      { href: '/c', label: 'Invoices', iconKey: 'grid' },
      { href: '/d', label: 'Reinvoices', iconKey: 'grid' },
    ],
  }]
  assert.deepEqual(searchPages(buildPageIndex(menu), 'invoices').map((hit) => hit.href), ['/c', '/b', '/a', '/d'])
})

test('matching ignores case and accents', () => {
  const menu: SidebarNavGroup[] = [{
    id: 'g', label: 'Comptabilité', iconKey: 'grid', items: [{ href: '/e', label: 'Écritures de journal', iconKey: 'grid' }],
  }]
  assert.deepEqual(searchPages(buildPageIndex(menu), 'ecritures').map((hit) => hit.href), ['/e'])
})
