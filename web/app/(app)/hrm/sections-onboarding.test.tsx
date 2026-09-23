import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// UX-14b: the Onboarding panel showed "Open checklists 1" immediately
// followed by "No open checklists." whenever processes were open but no
// step was overdue or due soon. The empty copy must never contradict the
// count: open processes with nothing due soon name that state and link to
// the open process list, and the generic empty renders only when the
// count is zero.

// jsdom first: the panel reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost:4800/hrm' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}

registerHooks({
  resolve(specifier, context, next) {
    // next/link renders a plain anchor outside the app router; stub it so
    // the test asserts the href without loading the router.
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:String(p.href)},p.children)}`,
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { OnboardingPanel } = await import('./sections')

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const BASE = {
  openLabel: 'Open checklists',
  overdueLabel: 'Overdue',
  upcomingLabel: 'Due soon',
  empty: 'No open checklists.',
  noDueSoon: 'No checklist steps due in the next 7 days.',
  viewAll: 'View all processes',
  viewAllHref: '/hrm/processes',
}

async function renderPanel(props: Partial<typeof BASE> & { openCount: number }) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <OnboardingPanel
        openCount={props.openCount}
        overdue={[]}
        upcoming={[]}
        openLabel={props.openLabel ?? BASE.openLabel}
        overdueLabel={props.overdueLabel ?? BASE.overdueLabel}
        upcomingLabel={props.upcomingLabel ?? BASE.upcomingLabel}
        empty={props.empty ?? BASE.empty}
        noDueSoon={props.noDueSoon ?? BASE.noDueSoon}
        viewAll={props.viewAll ?? BASE.viewAll}
        viewAllHref={props.viewAllHref ?? BASE.viewAllHref}
      />,
    )
    await tick()
  })
  await tick()
  const text = document.body.textContent ?? ''
  const link = [...document.querySelectorAll('a')].find((a) => a.textContent === BASE.viewAll)
  await act(async () => {
    root.unmount()
  })
  host.remove()
  return { text, linkHref: link?.getAttribute('href') ?? null }
}

test('open checklists with nothing due soon name that state and link out (UX-14b)', async () => {
  // Pre-fix the panel printed the generic empty directly under the count:
  // "Open checklists 1" followed by "No open checklists."
  const { text, linkHref } = await renderPanel({ openCount: 1 })
  assert.ok(text.includes('1'), 'the open count must render')
  assert.ok(!text.includes(BASE.empty), 'the generic empty must not contradict the count')
  assert.ok(text.includes(BASE.noDueSoon), 'the panel must name the nothing-due-soon state')
  assert.equal(linkHref, '/hrm/processes', 'the panel must link to the open process list')
})

test('zero open checklists keeps the generic empty state (UX-14b)', async () => {
  const { text, linkHref } = await renderPanel({ openCount: 0 })
  assert.ok(text.includes(BASE.empty), 'with nothing open the generic empty renders')
  assert.ok(!text.includes(BASE.noDueSoon), 'the nothing-due-soon copy needs open processes')
  assert.equal(linkHref, null, 'no process list link without open processes')
})
