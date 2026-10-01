import assert from 'node:assert/strict'
import test from 'node:test'
import { safeNavigationHref, validLocalNavigationPreferences } from './preferences'
import { configureInlineTabs } from '../../components/module-home/inline-tabs'
import { resolveViewTabs } from '../../components/module-home/view-tab-match'

test('custom links refuse ambiguous origins, unsafe schemes, credentials and control characters', () => {
  for (const href of ['//example.com', '/\\example.com', '/foo\nbar', 'javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com']) assert.equal(safeNavigationHref(href), false, href)
  for (const href of ['/customers', '/inventory?inventoryView=counts', 'https://example.com/path']) assert.equal(safeNavigationHref(href), true, href)
})

test('local configuration accepts only registered destinations and unique identities', () => {
  const catalog = new Map([['payroll', new Set(['/payroll', '/payroll/runs'])]])
  assert.ok(validLocalNavigationPreferences({ payroll: { items: [{ href: '/payroll/runs', hidden: true }] } }, catalog))
  assert.ok(!validLocalNavigationPreferences({ payroll: { items: [{ href: '/admin/setup' }] } }, catalog))
  assert.ok(!validLocalNavigationPreferences({ forged: { items: [] } }, catalog))
  assert.ok(!validLocalNavigationPreferences({ payroll: { items: [{ href: '/payroll' }, { href: '/payroll' }] } }, catalog))
})

test('inline preferences preserve live counts, selection, and page-approved hrefs', () => {
  const tabs = [{ href: '/journal?sub=entity&book=book', label: 'Entries', count: 10 }, { href: '/journal?journalTab=drafts&sub=entity', label: 'Drafts', count: 3, active: true }]
  const configured = configureInlineTabs(tabs, { 'journal-views': { items: [{ href: '/journal?journalTab=drafts', label: 'Unposted' }, { href: '/journal' }] } })
  assert.deepEqual(configured, [{ ...tabs[1], label: 'Unposted' }, tabs[0]])
  assert.deepEqual(configureInlineTabs(tabs, { 'journal-views': { items: [{ href: '/journal', hidden: true }] } }), [tabs[1]])
})

test('route switches preserve named organization lenses and reset task-specific filters', () => {
  const tabs = resolveViewTabs([[{ href: '/hrm/positions', label: 'Positions', carry: ['sub', 'book', 'status'], sharedCarry: ['sub', 'book'] }, { href: '/hrm/recruiting?tab=offers', label: 'Offers', carry: ['sub', 'book', 'status'], sharedCarry: ['sub', 'book'] }]], '/hrm/positions', new URLSearchParams('sub=entity&book=ledger&status=open&candidate=private'))!
  const target = new URL(tabs[1]!.href, 'https://example.com')
  assert.equal(target.searchParams.get('sub'), 'entity')
  assert.equal(target.searchParams.get('book'), 'ledger')
  assert.equal(target.searchParams.get('status'), null)
  assert.equal(target.searchParams.get('candidate'), null)
  assert.equal(target.searchParams.get('tab'), 'offers')
})


test('a hidden current route keeps its authorized sibling strip without selecting another page', () => {
  const groups = [[{ href: '/payroll/runs', label: 'Pay runs' }, { href: '/payroll/remittances', label: 'Remittances' }]]
  const tabs = resolveViewTabs(groups, '/payroll', new URLSearchParams(), [{ href: '/payroll', group: 0 }])!
  assert.equal(tabs.length, 2)
  assert.ok(tabs.every((tab) => !tab.active))
  assert.equal(resolveViewTabs([[]], '/payroll', new URLSearchParams(), [{ href: '/payroll', group: 0 }]), null)
})
