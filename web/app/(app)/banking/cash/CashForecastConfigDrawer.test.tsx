import assert from 'node:assert/strict'
import test from 'node:test'

// F1T-14 (the cash forecast config drawer was fully English: hardcoded
// labels, notes, values and a raw ISO as-of date): every string resolves
// through banking.cash.config in the operator locale, counts use ICU
// plurals, and the as-of date is locale-formatted.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/banking/cash',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: true,
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
        url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}export function usePathname(){return "/banking/cash"}export function useSearchParams(){return new URLSearchParams()}',
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
const { MoneyProvider } = await import('../../../../components/money-provider')
const { CashForecastConfigDrawer } = await import('./CashForecastConfigDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const props = {
  onClose() {},
  title: 'Config',
  description: 'Desc',
  asOf: '2026-01-05',
  horizonWeeks: 6,
  dso: 30,
  dpo: 21,
  weeklyCap: '0.0000',
  restrictToSafe: true,
  vendorOptions: [],
  accountOptions: [],
  subsidiaryOptions: [],
  initialCategories: [],
}

async function mount(locale: string) {
  const messages = (await import(`../../../../messages/${locale}`)).default
  globalThis.fetch = (async () => Response.json({ categories: [], revision: 1 })) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <CashForecastConfigDrawer {...props} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

test('the config drawer translates every label and formats the as-of date (F1T-14)', async () => {
  const expectations: Record<string, { labels: string[]; asOf: string; horizon: string }> = {
    en: { labels: ['Forecast horizon', 'Forecast Model', 'Weekly pay cap', 'Unlimited'], asOf: 'Jan 5, 2026', horizon: '6 weeks' },
    de: { labels: ['Prognosehorizont', 'Prognosemodell', 'Wöchentliche Zahlungsobergrenze', 'Unbegrenzt'], asOf: '5. Jan. 2026', horizon: '6 Wochen' },
    fr: { labels: ['Horizon de prévision', 'Modèle de prévision', 'Plafond hebdomadaire', 'Illimité'], asOf: '5 janv. 2026', horizon: '6 semaines' },
  }
  for (const [locale, expected] of Object.entries(expectations)) {
    const { host, root } = await mount(locale)
    // The Drawer portals into document.body, so assertions read the body —
    // host text is always empty.
    const text = document.body.textContent ?? ''
    for (const label of expected.labels) {
      assert.ok(text.includes(label), `${locale} drawer must show ${label}`)
    }
    assert.ok(text.includes(expected.asOf), `${locale} drawer must format the as-of date as ${expected.asOf}`)
    assert.ok(text.includes(expected.horizon), `${locale} drawer must pluralize the horizon as ${expected.horizon}`)
    assert.ok(!text.includes('2026-01-05'), `${locale} drawer must not leak the raw ISO date`)
    // Unmount before the next locale mounts so one locale's copy never
    // satisfies another locale's assertions.
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('a non-English drawer carries no English config copy (F1T-14)', async (t) => {
  const { host, root } = await mount('de')
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const text = document.body.textContent ?? ''
  for (const english of ['Forecast horizon', 'Forecast Model', 'Weekly pay cap', 'Restrict to safe capacity', 'Business-day snap']) {
    assert.ok(!text.includes(english), `the German drawer must not contain English ${english}`)
  }
})
