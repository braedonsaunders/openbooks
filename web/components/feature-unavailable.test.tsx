import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// Render proof for the shared feature-unavailable presentation as a list body
// uses it: real en catalogs, the real page layout and header, and the real
// header-action rule from globals.css evaluated by the DOM's selector engine.
// Only translation lookup, links and navigation hooks are scripted.

const root = new URL('../../', import.meta.url)
const catalog = (name: string) => JSON.parse(readFileSync(new URL(`web/messages/en/${name}.json`, root), 'utf8')) as unknown
;(globalThis as Record<string, unknown>).__featureUnavailableBundles = { shell: catalog('shell'), admin: catalog('admin') }

const INTL = `
  function walk(ns, key) {
    let node = globalThis.__featureUnavailableBundles;
    for (const part of String(ns).split('.').concat(String(key).split('.'))) node = node?.[part];
    if (typeof node !== 'string') throw new Error('MISSING_MESSAGE:' + ns + '.' + key);
    return node;
  }
  export async function getTranslations(ns) {
    const t = (key, params) => walk(ns, key).replace(/\\{(\\w+)\\}/g, (m, k) => params?.[k] ?? m);
    t.has = (key) => { try { walk(ns, key); return true } catch { return false } };
    return t;
  }
`
const { stubModules } = await import('../testing/stub-modules')
stubModules({
  navigation: { pathname: '/manufacturing/time' },
  intl: INTL,
  extra: { 'next/link': `export default function Link(p) { return globalThis.React.createElement('a', { href: p.href }, p.children) }` },
})
await bootJsdomEnvironment({ url: 'http://localhost:4800/manufacturing/time' })
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { PageHeader } = await import('@openbooks/ui')
const { ListPageLayout } = await import('./page-layout')
const { FeatureUnavailable } = await import('./feature-unavailable')

/** The globals.css selector that withdraws header actions above a disabled body. */
function withdrawnActionsSelector(): string {
  const css = readFileSync(new URL('web/app/globals.css', root), 'utf8')
  const rule = css.split('}').find((block) => block.includes('[data-route-placement="section"]'))
  assert.ok(rule, 'globals.css carries the header-action rule for a disabled body')
  return rule.slice(rule.lastIndexOf('*/') + 2, rule.indexOf('{')).trim()
}

async function listPage(canManageFeatures: boolean): Promise<Element> {
  const body = await FeatureUnavailable({ featureKey: 'timeTracking', canManageFeatures })
  const header = (
    <PageHeader
      title="Weekly timesheets"
      description="Employee time by the week."
      actions={<>
        <a href="/timesheets?timesheet=new">New timesheet</a>
        <div data-subtabs-track><a href="/manufacturing/work-orders">Work orders</a></div>
      </>}
    />
  )
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<ListPageLayout header={header}>{body}</ListPageLayout>)
  return host
}

test('a list body whose feature is off shows the shared canvas once, by name, and withdraws header actions', async () => {
  const page = await listPage(true)
  const canvases = page.querySelectorAll('[data-route-state="feature-disabled"]')
  assert.equal(canvases.length, 1, 'one shared canvas replaces the list body')
  const canvas = canvases[0]!
  assert.equal(canvas.getAttribute('data-route-placement'), 'section')
  assert.equal(page.querySelectorAll('h1').length, 1, 'the page keeps its own single title')
  assert.equal(page.querySelector('h1')?.textContent, 'Weekly timesheets')
  assert.equal(canvas.querySelector('h2')?.textContent, 'Time tracking is turned off')
  assert.equal(page.textContent?.split('Time tracking is turned off').length, 2, 'the refusal reads once')
  assert.ok(canvas.textContent?.includes('This area needs the Time tracking feature.'))
  assert.doesNotMatch(page.textContent ?? '', /timeTracking|feature_disabled|Company Settings/, 'no key, code or remedy text leaks')
  const features = canvas.querySelector('a[href="/admin/setup/features"]')
  assert.equal(features?.textContent, 'Open Features')

  const withdrawn = [...page.querySelectorAll(withdrawnActionsSelector())]
  assert.deepEqual(withdrawn.map((element) => element.textContent), ['New timesheet'], 'only the create action is withdrawn')
  assert.ok(!withdrawn.some((element) => element.querySelector('[href="/manufacturing/work-orders"]')), 'sibling navigation stays')
})

test('a healthy list body keeps every header action', async () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <ListPageLayout header={<PageHeader title="Weekly timesheets" actions={<a href="/timesheets?timesheet=new">New timesheet</a>} />}>
      <table><tbody><tr><td>Week of Oct 5</td></tr></tbody></table>
    </ListPageLayout>,
  )
  assert.equal(host.querySelectorAll(withdrawnActionsSelector()).length, 0)
})

test('without setup authority the canvas names an administrator and offers no Features link', async () => {
  const page = await listPage(false)
  const canvas = page.querySelector('[data-route-state="feature-disabled"]')!
  assert.equal(canvas.querySelector('a[href="/admin/setup/features"]'), null)
  assert.ok(canvas.textContent?.includes('ask your administrator'))
  assert.ok(canvas.querySelector('a[href="/dashboard"]'), 'the reader still has a way out')
})

test('the inline variant explains one unavailable panel with the same copy and remedy', async () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(await FeatureUnavailable({ featureKey: 'projects', canManageFeatures: true, placement: 'inline' }))
  const panel = host.querySelector('[data-feature-state="disabled"]')
  assert.equal(panel?.getAttribute('data-feature-key'), 'projects')
  assert.equal(panel?.querySelector('h3')?.textContent, 'Projects & job costing is turned off')
  assert.equal(host.querySelectorAll('[data-route-state]').length, 0, 'a panel never takes over its page')
  assert.equal(panel?.querySelector('a[href="/admin/setup/features"]')?.textContent, 'Open Features')
})
