import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F3-14: the flag drawer showed the kind label under Severity and the
// employment label under Status. Every fact sits under its own heading
// now: the severity value under Severity, the status value under Status,
// with kind and employment in their own rows. Mounts the real drawer under
// jsdom and reads the term/value pairs out of the definition list.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/anomalies?flag=flag-1',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {refresh(){},push(){},replace(){},back(){},prefetch(){}}}export function usePathname(){return "/payroll/anomalies"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
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
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { AnomalyDrawer } = await import('./islands')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

type Flag = Parameters<typeof AnomalyDrawer>[0]['flag']

const flag = {
  id: 'flag-1',
  severityLabel: 'Block',
  severityVariant: 'negative',
  kindLabel: 'Duplicate bank',
  periodLabel: '2026-09-01 → 2026-09-30',
  employmentLabel: 'Ada',
  explanation: 'The same bank account appears on two employees.',
  statusLabel: 'Open',
  statusVariant: 'warning',
  openLabel: 'Open',
  flagHref: '/payroll/anomalies?flag=flag-1',
  detail: null,
  reason: null,
  runDocumentId: null,
  severityTerm: 'Severity',
  kindTerm: 'Kind',
  employmentTerm: 'Employee',
  statusTerm: 'Status',
  transitionLabels: {
    acknowledge: 'Acknowledge',
    resolve: 'Resolve',
    falsePositive: 'False positive',
    reasonLabel: 'Reason',
    reasonPlaceholder: 'Why?',
    submitLabel: 'Submit',
    failedLabel: 'Failed',
  },
} as unknown as Flag

function pairs(): Array<[string, string]> {
  return [...document.querySelectorAll('dl > div')].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ])
}

test('every fact sits under its own heading', async (t: TestContext) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const child of [...document.body.children]) child.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AnomalyDrawer flag={flag} closeHref="/payroll/anomalies" />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  const rows = pairs()
  assert.ok(rows.length >= 4, `expected the four fact rows, got ${JSON.stringify(rows)}`)
  const byTerm = new Map(rows)
  assert.equal(byTerm.get('Severity'), 'Block')
  assert.equal(byTerm.get('Status'), 'Open')
  assert.equal(byTerm.get('Kind'), 'Duplicate bank')
  assert.equal(byTerm.get('Employee'), 'Ada')
})
