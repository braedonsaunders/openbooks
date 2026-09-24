import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { TrueCostData } from '../../../../lib/analytics/true-cost-data'

// True Cost mutations check the status before parsing: a failed pin surfaces
// the server's refusal in a toast — never a JSON parse error over a
// non-JSON error body.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/analytics/true-cost',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__tcRouter}export function usePathname(){return \'/analytics/true-cost\'}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    return next(specifier, context)
  },
})

declare global {
  var __tcRouter: { push(url: string): void; refresh(): void } | undefined
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { Toaster } = await import('sonner')
const { renderToStaticMarkup } = await import('react-dom/server')
const { TrueCostView } = await import('./TrueCostView')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function fixture(): TrueCostData {
  return {
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    departments: [],
    kpis: {
      compositeRate: 45,
      compositeRateChangePct: null,
      totalOverhead: 900,
      overheadAccounts: 1,
      burdenApplied: 800,
      gap: -100,
      gapPerHour: -1,
      absorptionPct: 89,
      billedHours: 100,
      totalHours: 120,
      utilization: 83,
      employeeCount: 2,
    },
    categories: [
      {
        id: 'g-rent',
        key: 'rent',
        name: 'Rent',
        color: '#0d9488',
        categoryType: 'expense',
        match: {},
        totalAmount: 900,
        rate: 9,
        rawRate: 9,
        allocationBase: 'total_hours',
        allocationMethod: 'simple',
        rateFormat: 'per_hour',
        includeInComposite: true,
        rateDisplay: '$9.00/hr',
        accounts: [],
        byDept: {},
      },
    ],
    unassigned: [{ id: 'a-clean', number: '6100', name: 'Cleaning', amount: 50, pinned: false, deptAmounts: {}, untaggedAmount: 50 }],
    totals: { byDept: {}, overall: 950 },
    labor: { employees: [], count: 0, min: 0, max: 0, weighted: 0 },
    monthly: [],
    forecast: [],
    hasBurdenGL: true,
    bases: {},
    ratePublication: { supported: true, blockers: [] },
    config: {
      activeProfileId: 'p1',
      compositeMethod: 'simple',
      baseLaborRate: 50,
      fringeRate: 0.2,
      categorySettings: {},
      profiles: [{ id: 'p1', name: 'Default' }],
      customCategories: [],
    },
  } as unknown as TrueCostData
}

function providers(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <Toaster />
        {ui}
      </MoneyProvider>
    </NextIntlClientProvider>
  )
}

test('a failed assign toasts the server refusal, never a parse error', async () => {
  globalThis.__tcRouter = { push() {}, refresh() {} }
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/account-groups/')) {
      // A proxy-style non-JSON failure body.
      return new Response('<html><body>Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })
    }
    return Response.json({})
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<TrueCostView data={fixture()} mode="setup" />))
      await tick()
    })
    await tick()
    // The shared Select proxies through a hidden native <select> (the visual
    // trigger carries the aria-label); driving the native control fires the
    // genuine change event the assign handler listens for.
    const assign = host.querySelector('select') as HTMLSelectElement | null
    assert.ok(assign, 'the unassigned account must offer a category assign picker')
    await act(async () => {
      assign.value = 'g-rent'
      assign.dispatchEvent(new window.Event('change', { bubbles: true }))
      await tick()
    })
    let text = ''
    for (let i = 0; i < 40 && !text.includes('Request failed (status 502)'); i++) {
      await tick()
      text = document.body.textContent ?? ''
    }
    assert.ok(
      text.includes('Request failed (status 502)'),
      `the operator must see the refusal with its status, got:\n${text}`,
    )
    assert.ok(!text.includes('SyntaxError'), `a parse error must never surface, got:\n${text}`)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    globalThis.fetch = priorFetch
  }
})

// F-t09-003: with no `burden`-dimension category the Assign picker is empty,
// so the Categories tab must name the dimension requirement outright.
test('the Categories tab renders the burden-dimension guidance when no category exists', () => {
  const data = fixture()
  data.categories = []
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <TrueCostView data={data} mode="setup" />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
  assert.match(html, /burden/, 'the empty state must name the burden dimension')
  assert.match(html, /href="\/admin\/setup\/account-groups"/, 'the empty state must link category authoring')
})
