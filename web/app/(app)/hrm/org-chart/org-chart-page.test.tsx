import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { OrgChart, OrgChartNode } from '@openbooks/engine/src/hrm/org-chart.ts'
import { EMPTY_ORG_CHART_LAYOUT, type OrgChartLayout } from '@openbooks/engine/src/hrm/org-chart-layout-schema.ts'
import { chartEdges, canConnectManager } from './graph'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost/hrm/org-chart', event: 'jsdom' })
Object.assign(globalThis, { MutationObserver: window.MutationObserver })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: "export function useRouter(){return { push(){}, refresh(){} }} export function useSearchParams(){return new URLSearchParams()} export function usePathname(){return '/hrm/org-chart'}" })
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = React
const { NextIntlClientProvider } = await import('next-intl')
const common = (await import('../../../../messages/en/common.json', { with: { type: 'json' } })).default
const ui = (await import('../../../../messages/en/ui.json', { with: { type: 'json' } })).default
const { OrgChartTree } = await import('./sections')
const messages = (await import('../../../../messages/en/hrm.json', { with: { type: 'json' } })).default
const LABELS = { ...messages.orgChart.labels, retry: common.actions.retry, cancel: common.actions.cancel }
const node = (name: string, children: OrgChartNode[] = []): OrgChartNode => ({ employmentId: randomUUID(), partyId: randomUUID(), positionId: null, positionCode: null, name, title: 'Engineer', department: 'Workshop', vacant: false, spanOfControl: children.length, layer: 0, children })
const ada = node('Ada'), boss = node('Boss', [ada]), other = node('Other manager')
const chart = { roots: [boss, other], asOf: '2026-09-30' } as OrgChart
const placement = (person: OrgChartNode) => ({ id: randomUUID(), kind: 'employee' as const, referenceId: person.employmentId!, position: { x: 0, y: 0 } })

test('real manager edges derive from current HR data only for employees placed manually', () => {
  assert.deepEqual(chartEdges(EMPTY_ORG_CHART_LAYOUT.graph, chart.roots), [])
  const a = placement(ada), b = placement(boss), c = placement(other)
  const graph: OrgChartLayout = { nodes: [a, b, c], edges: [] }
  assert.deepEqual(chartEdges(graph, chart.roots).map(({ source, target }) => ({ source, target })), [{ source: b.id, target: a.id }])
  const changed = [ { ...boss, children: [] }, { ...other, children: [ada] } ]
  assert.deepEqual(chartEdges(graph, changed).map(({ source, target }) => ({ source, target })), [{ source: c.id, target: a.id }])
  assert.equal(canConnectManager(chart.roots, ada.employmentId!, boss.employmentId!), false)
  assert.equal(canConnectManager(chart.roots, other.employmentId!, ada.employmentId!), true)
})

async function mount(editable: boolean) {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="America/Toronto" messages={{ common, ui }}><OrgChartTree chart={chart} personBaseHref="/hrm/org-chart" labels={LABELS} canEditLayout={editable} /></NextIntlClientProvider>) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
test('employees remain in the sidebar while the new canvas starts empty', async (t) => {
  const { host, unmount } = await mount(true); t.after(unmount)
  assert.ok(host.querySelector('[data-testid="org-chart-canvas"]'))
  assert.equal(host.querySelectorAll('.react-flow__node').length, 0)
  assert.ok(host.textContent?.includes('Ada'))
  assert.ok(host.textContent?.includes(LABELS.startEmpty))
  assert.ok(host.querySelectorAll('[draggable="true"]').length >= 3)
  const add = [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === `${LABELS.addToChart}: Ada`)
  assert.ok(add, 'keyboard users can place an employee without dragging')
  await act(async () => add.click())
  assert.equal(host.querySelectorAll('.react-flow__node').length, 1)
  assert.ok(host.querySelector('.react-flow__node')?.textContent?.includes('Ada'))
})
test('viewers see the saved workspace without editing controls or draggable employees', async (t) => {
  const { host, unmount } = await mount(false); t.after(unmount)
  assert.equal(host.querySelectorAll('[draggable="true"]').length, 0)
  assert.equal([...host.querySelectorAll('button')].some(button => button.textContent?.includes(LABELS.saveLayout)), false)
  assert.ok(host.textContent?.includes(LABELS.readOnlyEmpty))
  assert.equal(host.querySelector("aside"), null)
  assert.equal(host.querySelector("input"), null)
})
