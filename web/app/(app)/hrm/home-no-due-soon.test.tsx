import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function getTranslations(){const t=(k)=>k;return t};export async function getLocale(){return "en"}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:String(p.href)},p.children)}`,
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const useRouter = () => ({ refresh(){}, push(){}, replace(){} });export function redirect(){ throw new Error("redirect") };export const useSearchParams = () => new URLSearchParams();export const usePathname = () => "/hrm"',
      }
    }
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast = { success(){}, error(){}, info(){} }' }
    }
    return next(specifier, context)
  },
})
const { hrmSpec } = await import('./view')
// The HRM slice of the real widget registry: the same renderer the page
// serves for this block, without the world the full registry pulls in.
const { HRM_WIDGETS } = await import('../../../components/viewspec/widgets-hrm')
// tsx compiles JSX classic: the spec never imports React, so the test bridges it.
Object.assign(globalThis, { React })

function findBlocks(node: unknown, name: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const value of node) findBlocks(value, name, out)
    return out
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (record.widget === name && record.props !== null && typeof record.props === 'object') {
      out.push(record.props as Record<string, unknown>)
    }
    for (const value of Object.values(record)) findBlocks(value, name, out)
  }
  return out
}

const NO_DUE_SOON = 'No checklist steps due in the next 7 days.'

function homeData(): Record<string, unknown> {
  return {
    title: 'HRM',
    description: 'People',
    tabs: [],
    actions: [],
    canCreateEmployee: false,
    canProposeChange: false,
    canCreateProcess: false,
    newEmployee: { label: 'New' },
    newProcessLabel: 'Process',
    pending: [],
    pendingEmpty: 'None pending.',
    pendingQueueHref: '/hrm/change-requests',
    pendingViewAll: 'View all',
    pendingRefusal: null,
    queueNotAvailable: 'N/A',
    onboarding: {
      openCount: 1,
      overdue: [],
      upcoming: [],
      panelTitle: 'Onboarding',
      openLabel: 'Open checklists',
      overdueLabel: 'Overdue',
      upcomingLabel: 'Due soon',
      empty: 'No open checklists.',
      noDueSoon: NO_DUE_SOON,
      viewAll: 'View all processes',
      viewAllHref: '/hrm/processes',
    },
    onboardingHasActivity: true,
    groups: [],
    multiSubsidiary: false,
  }
}

// UX-14b: /hrm showed "Open checklists 1" with a blank explanation area:
// home.ts supplied noDueSoon but the spec never passed it to the widget,
// so the widget rendered its empty-string fallback. The spec must carry
// the loader's string end to end.
test('the home spec passes the nothing-due-soon explanation to the onboarding widget', () => {
  const spec = hrmSpec(homeData() as never)
  const blocks = findBlocks(spec, 'hrm-onboarding-panel')
  assert.equal(blocks.length, 1, 'the home renders one onboarding panel')
  assert.equal(blocks[0]?.noDueSoon, NO_DUE_SOON, 'the loader string reaches the widget props')
})

test('the wired widget renders the explanation with open checklists and nothing due', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm',
  })
  const previous = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    navigator: (globalThis as Record<string, unknown>).navigator,
  }
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  try {
    const spec = hrmSpec(homeData() as never)
    const props = findBlocks(spec, 'hrm-onboarding-panel')[0]
    assert.ok(props, 'the panel block exists')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const root = createRoot(dom.window.document.getElementById('root')!)
    const renderWidget = HRM_WIDGETS['hrm-onboarding-panel']
    assert.ok(renderWidget, 'the real registry serves the onboarding panel')
    await act(async () => {
      root.render(<>{renderWidget(props!)}</>)
    })
    const text = dom.window.document.body.textContent ?? ''
    assert.match(text, /Open checklists/, 'the count label renders')
    assert.match(text, /1/, 'the open count renders')
    assert.ok(!text.includes('No open checklists.'), 'the generic empty does not contradict the count')
    assert.ok(text.includes(NO_DUE_SOON), 'the nothing-due-soon explanation renders through the real widget')
    await act(async () => {
      root.unmount()
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    dom.window.close()
  }
})
