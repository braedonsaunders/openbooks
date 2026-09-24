import assert from 'node:assert/strict'
import test from 'node:test'
import type { BankingCashData } from './view'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export default {}' }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href},p.children)}',
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {push(){}}}export function usePathname(){return "/banking/cash"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    return next(specifier, context)
  },
})

const { bankingCashSpec } = await import('./view')

function blockedData(): BankingCashData {
  return {
    ratesBlocked: {
      code: 'rates-not-derived',
      title: 'Rates have not been derived',
      description: 'No consolidated exchange rates for EUR for March 2026.',
      deriveLabel: 'Derive rates',
      deriveHref: '/close',
    },
    ratesReady: false,
  } as unknown as BankingCashData
}

function blocksOf(spec: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
    } else if (typeof node === 'object' && node !== null) {
      found.push(node as Record<string, unknown>)
      for (const value of Object.values(node)) visit(value)
    }
  }
  visit((spec as { body: unknown }).body)
  return found
}

test('a rates refusal renders a derive action and withholds the cash cockpit', () => {
  const blocks = blocksOf(bankingCashSpec(blockedData()))
  const banner = blocks.find((block) => block.widget === 'empty-state')
  assert.ok(banner, 'the rates refusal must be visible as an empty-state banner')
  assert.deepEqual(banner.when, { $: 'ratesBlocked' })
  const props = banner.props as Record<string, unknown>
  assert.equal(props.title, 'Rates have not been derived')
  assert.equal(props.description, 'No consolidated exchange rates for EUR for March 2026.')
  assert.equal(props.action, 'link-button')
  assert.deepEqual(props.actionProps, { href: '/close', label: 'Derive rates' })

  const cockpit = blocks.find((block) => block.widget === 'cash-cockpit')
  assert.ok(cockpit, 'the cash cockpit remains the normal ready-state view')
  assert.deepEqual(cockpit.when, { $: 'ratesReady' }, 'rates refusal must hide the FX-bearing forecast')
})

test('an empty account panel names the setup remedy and links to Banking', async (t) => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/banking/cash' })
  const globals = globalThis as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
    if (globals[key] === undefined) globals[key] = domWindow[key]
  }
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
  }
  if (typeof globals.ResizeObserver !== 'function') {
    globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  }
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react')
  Object.assign(globalThis, { React })
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { NextIntlClientProvider } = await import('next-intl')
  const messages = (await import('../../../../messages/en')).default
  const { MoneyProvider } = await import('../../../../components/money-provider')
  const { CashCockpit } = await import('./CashCockpit')
  const priorFetch = globalThis.fetch
  const hiddenPanels = ['timeline', 'forecast', 'bridge', 'health', 'stats']
  globalThis.fetch = (async () => Response.json({ layout: { hidden: hiddenPanels }, revision: 'revision-1' })) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = priorFetch
    dom.window.close()
  })

  const data = {
    asOf: '2026-09-24', horizonWeeks: 13, startingCash: '3750.00', bankAccounts: [], weeks: [],
    totalInflows: '0.00', totalOutflows: '0.00', netChange: '0.00', projectedEnd: '3750.00',
    lowestCash: '3750.00', lowestWeek: '2026-09-24', burnRate: '0.00', runwayWeeks: null,
    runwayStatus: 'healthy', deferredBeyondHorizon: '0.00', dso: 0, dpo: 0,
    arOutstanding: '0.00', apOutstanding: '0.00', arCoverage: null, categories: [],
    apSettings: { weeklyCap: '0.00', restrictToSafe: false }, vendorOptions: [], accountOptions: [], subsidiaryOptions: [],
  } as unknown as React.ComponentProps<typeof CashCockpit>['data']

  await act(async () => {
    root.render(
      React.createElement(
        NextIntlClientProvider,
        { locale: 'en', messages, timeZone: 'UTC' } as unknown as React.ComponentProps<typeof NextIntlClientProvider>,
        React.createElement(
          MoneyProvider,
          { currency: 'USD' } as React.ComponentProps<typeof MoneyProvider>,
          React.createElement(CashCockpit, {
            data,
            layoutPrefs: { hidden: hiddenPanels },
            canConfigure: false,
            canPayRun: false,
            canCollectionRun: false,
          }),
        ),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
  })

  const emptyText = 'No bank accounts yet. Connect one on the Banking overview to see balances and runway here.'
  assert.ok(host.textContent?.includes(emptyText), 'the empty account panel must explain the missing setup')
  const setupLink = [...host.querySelectorAll('a')].find((link) => link.textContent?.trim() === 'Go to Banking')
  assert.ok(setupLink, 'the panel must offer the Banking setup action')
  assert.equal(setupLink.getAttribute('href'), '/banking')
})
