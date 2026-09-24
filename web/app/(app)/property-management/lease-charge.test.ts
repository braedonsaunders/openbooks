import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { ComponentType, ReactNode } from 'react'
import type { LeaseRow, WorkspaceOptions } from './types'

// F-t09-010: lease Add-charge always 422d ('Charge tax code is invalid') and
// failed silently on a missing toast key. The form state carries an empty
// taxCodeId with no tax field, and the submit spread it verbatim while the
// server rejects '' as a non-uuid — so no CAM/parking/storage charge could
// be added. The submit must send null when unset. The toasts block never
// existed in English (the runtime merges every locale over en, and the
// property-management namespace is tracked English fallback), so the source
// block plus manifest-declared fallbacks cover all seven locales.
const MESSAGES = join(import.meta.dirname, '..', '..', '..', 'messages')
const LOCALES = ['fr', 'de', 'es', 'pt-BR', 'ja', 'zh']
const TOAST_KEYS = [
  'actionFailed', 'camPoolCreated', 'camPoolReopened', 'camPoolUpdated',
  'chargeAdded', 'couldNotLoad', 'depositPosted', 'depositReversed',
  'escalationApplied', 'escalationScheduled', 'lateFeesAssessed',
  'leaseCreated', 'leaseUpdated', 'propertyCreated', 'propertyDeleted',
  'propertyUpdated', 'rentBilled', 'unitAdded', 'unitDeleted', 'unitUpdated',
]

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/properties?lease=lease-1' })
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'self']) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    ;(globalThis as Record<string, unknown>)[key] = domWindow[key]
  }
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { registerHooks } = await import('node:module')
const { pathToFileURL } = await import('node:url')
const path = await import('node:path')
const uiEntry = pathToFileURL(path.join(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/ui') return { shortCircuit: true, url: uiEntry }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const englishMessages = (await import('../../../messages/en')).default
const { ChargesSection } = await import('./LeaseSections')
const IntlProvider = NextIntlClientProvider as unknown as ComponentType<{
  locale: string
  messages: typeof englishMessages
  timeZone: string
  children?: ReactNode
}>

test('English sources every property-management toast', () => {
  const catalog = JSON.parse(readFileSync(join(MESSAGES, 'en', 'entities.json'), 'utf8')) as {
    propertyManagement?: { toasts?: Record<string, string> }
  }
  for (const key of TOAST_KEYS) {
    const label = catalog.propertyManagement?.toasts?.[key]
    assert.ok(label && label !== key, `en is missing entities.propertyManagement.toasts.${key}`)
  }
})

for (const locale of LOCALES) {
  test(`${locale} localizes the property-management toasts or declares a fallback`, () => {
    const catalog = JSON.parse(readFileSync(join(MESSAGES, locale, 'entities.json'), 'utf8')) as {
      propertyManagement?: { toasts?: Record<string, string> }
    }
    const manifest = JSON.parse(readFileSync(join(MESSAGES, 'untranslated-fallbacks.json'), 'utf8')) as {
      fallbacks?: Record<string, string[]>
    }
    const declared = manifest.fallbacks?.[locale] ?? []
    for (const key of TOAST_KEYS) {
      const path = `entities.propertyManagement.toasts.${key}`
      const label = catalog.propertyManagement?.toasts?.[key]
      const translated = Boolean(label && label !== key)
      const fallback = declared.includes(path)
      assert.ok(
        translated || fallback,
        `${locale} must translate ${path} or list it in the fallback manifest`,
      )
      assert.ok(
        !(translated && fallback),
        `${locale} translated ${path} must leave the fallback manifest`,
      )
    }
  })
}

test('adding a charge with no tax selection submits a nullable tax code', async (t) => {
  const actions: Array<{ payload: Record<string, unknown>; success: string }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  const options: WorkspaceOptions = {
    subsidiaries: [], locations: [], tenants: [], incomeAccounts: [], expenseAccounts: [],
    liabilityAccounts: [], bankAccounts: [], assets: [], openInvoices: [],
  }
  const lease = {
    id: 'lease-1', startsOn: '2026-01-01', endsOn: null, status: 'active', currency: 'USD',
  } as unknown as LeaseRow
  await act(async () => {
    root.render(React.createElement(
      IntlProvider,
      { locale: 'en', messages: englishMessages, timeZone: 'UTC' },
      React.createElement(ChargesSection, {
        lease,
        charges: [],
        permissions: { manage: true, bill: true, account: true, bulk: true, customize: true },
        busy: false,
        act: async (payload, success) => {
          actions.push({ payload, success })
          return null
        },
        money: (value) => String(value),
        options,
      }),
    ))
  })
  const amount = document.querySelector('input[type="number"]') as HTMLInputElement | null
  assert.ok(amount)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(amount, '125.00')
    amount.dispatchEvent(new window.Event('input', { bubbles: true }))
    amount.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  const addLabel = englishMessages.entities.propertyManagement.leaseSections.charges.addCharge
  const addButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === addLabel)
  assert.ok(addButton)
  await act(async () => {
    addButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })

  assert.equal(actions.length, 1, 'one charge action is submitted')
  assert.equal(actions[0]?.payload.taxCodeId, null, 'an unset optional tax code reaches the API as null rather than an invalid empty UUID')
})
