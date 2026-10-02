import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useState } from 'react'
import { bootJsdomEnvironment } from '../../testing/jsdom-env'
import { stubModules } from '../../testing/stub-modules'
await bootJsdomEnvironment({ url: 'http://localhost/hrm', matchMediaMatches: false })
Object.assign(globalThis, { React })
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0)
window.cancelAnimationFrame = (id) => window.clearTimeout(id)
stubModules({ navigation: { source: `export function usePathname(){return window.location.pathname} export function useSearchParams(){return new URLSearchParams(window.location.search)} export function useRouter(){return {push(){},replace(){},refresh(){}}}` } })
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const { default: messages } = await import('../../messages/en')
const { RecordTabs } = await import('./record-tabs')
const { TopNav } = await import('../top-nav')

async function mount(node: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{node}</NextIntlClientProvider>))
  return { host, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
async function press(element: HTMLElement, key: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
}

test('record panels expose linked selection, roving focus, wraparound, and disabled choices', async () => {
  function Panels() {
    const [active, setActive] = useState('general')
    return <RecordTabs label="Record sections" active={active} onChange={setActive} tabs={[{ key: 'general', label: 'General' }, { key: 'disabled', label: 'Unavailable', disabled: true }, { key: 'history', label: 'History', count: 3 }]}><p>{active} content</p></RecordTabs>
  }
  const screen = await mount(<Panels />)
  try {
    const tabs = [...screen.host.querySelectorAll<HTMLButtonElement>('[role=tab]')]
    const panel = screen.host.querySelector<HTMLElement>('[role=tabpanel]')!
    assert.equal(tabs[0]!.tabIndex, 0); assert.equal(tabs[2]!.tabIndex, -1)
    assert.equal(tabs[0]!.getAttribute('aria-controls'), panel.id)
    tabs[0]!.focus(); await press(tabs[0]!, 'ArrowRight')
    assert.equal(document.activeElement, tabs[2]); assert.equal(tabs[2]!.getAttribute('aria-selected'), 'true')
    assert.equal(panel.getAttribute('aria-labelledby'), tabs[2]!.id); assert.match(panel.textContent!, /history content/)
    await press(tabs[2]!, 'ArrowRight'); assert.equal(document.activeElement, tabs[0])
    await press(tabs[0]!, 'End'); assert.equal(document.activeElement, tabs[2])
    await press(tabs[2]!, 'Home'); assert.equal(document.activeElement, tabs[0])
  } finally { await screen.close() }
})

test('workspace labels remain direct links while their openers support menus and focus return', async () => {
  const screen = await mount(<TopNav groups={[{ id: 'hrm', label: 'People', iconKey: 'users', groupHref: '/hrm', items: [
    { href: '/entities/employees', label: 'Employees', iconKey: 'users', subgroup: 'Workforce' },
    { href: '/hrm/positions', label: 'Positions', iconKey: 'users', subgroup: 'Hiring' },
    { href: '/payroll', label: 'Payroll', iconKey: 'wallet', subgroup: 'Payroll' },
  ] }]} />)
  try {
    assert.equal(screen.host.querySelector('a')!.getAttribute('href'), '/hrm')
    const opener = screen.host.querySelector<HTMLButtonElement>('button[aria-label="Open People menu"]')!
    opener.focus(); await press(opener, 'ArrowDown')
    const menu = document.querySelector<HTMLElement>('[role=menu][aria-label=People]')!
    assert.ok(menu); assert.equal(opener.getAttribute('aria-expanded'), 'true')
    assert.equal(menu.querySelectorAll('[data-nav-column]').length, 2)
    const entries = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')]
    assert.equal(document.activeElement, entries[0])
    await press(entries[0]!, 'End'); assert.equal(document.activeElement, entries.at(-1))
    await press(entries.at(-1)!, 'ArrowDown'); assert.equal(document.activeElement, entries[0])
    await press(entries[0]!, 'Escape'); assert.equal(opener.getAttribute('aria-expanded'), 'false'); assert.equal(document.activeElement, opener)
  } finally { await screen.close() }
})


test('hiding every managed choice cannot restore a legacy header strip', async () => {
  const { ViewTabsProvider } = await import('./navigation-context')
  const { ModuleHomeTabs } = await import('./tabs')
  const screen = await mount(<ViewTabsProvider managed groups={[[]]} ownership={[{ href: '/hrm', group: 0 }]}><ModuleHomeTabs tabs={[{ href: '/hrm', label: 'Overview' }, { href: '/hrm/positions', label: 'Positions' }]} /></ViewTabsProvider>)
  try { assert.equal(screen.host.querySelectorAll('a').length, 0) }
  finally { await screen.close() }
})


test('Employees, Org chart, checklists and templates share one route switch inside the page header action rail', async () => {
  const { ViewTabsProvider } = await import('./navigation-context')
  const { ModuleHomeTabs } = await import('./tabs')
  const { ListPageLayout } = await import('../page-layout')
  const { PageHeader } = await import('@openbooks/ui')
  const group = [
    { href: '/entities/employees', label: 'Employees' },
    { href: '/hrm/org-chart', label: 'Org chart' },
    { href: '/hrm/processes', label: 'Process checklists' },
    { href: '/hrm/processes/templates', label: 'Checklist templates' },
  ]
  try {
    for (const current of group) {
      window.history.replaceState({}, '', current.href)
      const screen = await mount(<ViewTabsProvider managed groups={[group]}><ListPageLayout header={<PageHeader title={current.label} actions={<><button>New</button><ModuleHomeTabs tabs={group} /></>} />}><PageHeader title="Record content" /></ListPageLayout></ViewTabsProvider>)
      try {
        const strips = screen.host.querySelectorAll('[data-subtabs]')
        assert.equal(strips.length, 1, `${current.label} must have exactly one shared switch`)
        const strip = strips[0]!
        assert.ok(strip.closest('header [data-page-actions]'), `${current.label} navigation must be in the header action rail`)
        const links = [...strip.querySelectorAll('a')]
        assert.deepEqual(links.map((link) => link.getAttribute('href')), group.map((tab) => tab.href))
        assert.equal(strip.querySelector('[aria-current=page]')?.getAttribute('href'), current.href)
        assert.ok(strip.classList.contains('rounded-lg'))
        assert.equal(screen.host.querySelectorAll('header')[1]!.querySelector('[data-subtabs]'), null, 'record content must not inherit page navigation')
      } finally { await screen.close() }
    }
  } finally { window.history.replaceState({}, '', '/hrm') }
})


test('header overflow preserves order, names the active destination and returns keyboard focus', async () => {
  const { ModuleHomeTabs } = await import('./tabs')
  const original = HTMLElement.prototype.getBoundingClientRect
  for (const available of [160, 1000]) {
  HTMLElement.prototype.getBoundingClientRect = function () {
    const width = this.hasAttribute('data-subtabs') ? available : this.hasAttribute('data-tab-measure') ? 110 : 0
    return new window.DOMRect(0, 0, width, 40)
  }
  const screen = await mount(<ModuleHomeTabs tabs={[{href:'/one',label:'One'}, {href:'/two',label:'Two'}, {href:'/three',label:'Three',active:true}].map(tab => ({...tab, secondary: available === 1000}))} />)
  try {
    const opener = screen.host.querySelector<HTMLButtonElement>('button[aria-haspopup=menu]')!
    assert.match(opener.textContent!, /More: Three/)
    opener.focus(); await press(opener, 'ArrowDown')
    const menu = document.querySelector<HTMLElement>('[role=menu]')!
    const entries = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')]
    assert.deepEqual(entries.map(item=>item.textContent), ['One','Two','Three'])
    assert.equal(document.activeElement, entries[0])
    await press(entries[0]!, 'End'); assert.equal(document.activeElement, entries[2])
    assert.equal(entries[2]!.getAttribute('aria-current'), 'page')
    await press(entries[2]!, 'Escape'); assert.equal(opener.getAttribute('aria-expanded'), 'false'); assert.equal(document.activeElement, opener)
  } finally { await screen.close(); HTMLElement.prototype.getBoundingClientRect = original }
  }
})
