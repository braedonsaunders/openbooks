import assert from 'node:assert/strict'
import test from 'node:test'
import type { SidebarNavGroup } from '../components/sidebar-nav'
import { selectMobileTabs } from './mobile-nav'

const groups: SidebarNavGroup[] = [
  {
    id: 'home',
    label: 'Home',
    iconKey: 'gauge',
    items: [
      {
        href: '/dashboard',
        label: 'Dashboard',
        iconKey: 'gauge',
        mobile: true,
      },
      { href: '/assistant', label: 'Assistant', iconKey: 'sparkles' },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    iconKey: 'activity',
    items: [
      { href: '/customers', label: 'Customers', iconKey: 'users' },
      { href: '/ar', label: 'Invoices', iconKey: 'file', mobile: true },
      { href: '/dashboard', label: 'Duplicate dashboard', iconKey: 'gauge' },
    ],
  },
]

test('selects tenant-pinned mobile destinations before workspace-order fallbacks', () => {
  assert.deepEqual(
    selectMobileTabs(groups, 4).map((item) => item.href),
    ['/dashboard', '/ar', '/assistant', '/customers'],
  )
})

test('deduplicates destinations and respects the requested tab count', () => {
  assert.deepEqual(
    selectMobileTabs(groups, 2).map((item) => item.href),
    ['/dashboard', '/ar'],
  )
})
