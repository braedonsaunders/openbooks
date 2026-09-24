import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __settingsRouter: { push(url: string): void; refresh(): void } | undefined
  var __settingsToasts: { kind: string; message: string }[] | undefined
}

// jsdom first: the form reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/settings',
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__settingsRouter}export function usePathname(){return "/admin/settings"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}`,
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast=Object.assign((m)=>{(globalThis.__settingsToasts??=[]).push({kind:'info',message:String(m)})},{success(m){(globalThis.__settingsToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__settingsToasts??=[]).push({kind:'error',message:String(m)})}});export function Toaster(){return null}`,
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
const settingsCopy = (await import('../../../../messages/en/admin.json', { with: { type: 'json' } })).default
  .settings as unknown as Record<string, Record<string, string>>
const { SettingsForm } = await import('./SettingsForm')

type FormProps = Parameters<typeof SettingsForm>[0]

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const INITIAL: FormProps['initial'] = {
  name: 'Acme',
  legalName: '',
  country: 'CA',
  baseCurrency: 'USD',
  timeZone: 'UTC',
  fiscalYearStartMonth: 1,
  reportingFramework: 'us_gaap',
  defaultLocale: 'en' as never,
  reportPdfStyle: 'formal',
  fairValueRangePolicy: 'off',
  requireVendorBillApproval: false,
  requireStockCountReview: false,
  controlAccounts: {
    ar: 'a1',
    ap: 'a2',
    bank: 'a3',
    taxCollected: 'a4',
    taxPaid: 'a5',
    employeePayable: 'a6',
    fxUnrealizedGainLoss: 'a7',
    fxRealizedGainLoss: 'a8',
  },
}

const PROPS: Omit<FormProps, 'initial'> = {
  accounts: [],
  currencies: [
    { code: 'USD', name: 'US Dollar' },
    { code: 'CAD', name: 'Canadian Dollar' },
  ],
  timeZones: ['UTC', 'America/Toronto'],
  vendorBillFlowConfigured: false,
}

interface SeenRequest {
  url: string
  method: string
  body: unknown
}

async function mountForm(initial: FormProps['initial'] = INITIAL) {
  globalThis.__settingsRouter = { push() {}, refresh() {} }
  globalThis.__settingsToasts = []
  const seen: SeenRequest[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return Response.json({ changed: true })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SettingsForm initial={initial} {...PROPS} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  return {
    seen,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      globalThis.fetch = prior
    },
  }
}

function saveButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === String(settingsCopy.saveSettings),
  ) as HTMLButtonElement | undefined
  assert.ok(button, 'the form must offer Save')
  return button
}

// F-t01-010: clearing Display name and saving gave zero feedback — Save
// stays enabled, the input carries no invalid state, and the empty value is
// silently rejected server-side. The field itself must carry the required
// error where the tester can still read it.
test('a blank display name pins an inline required error on the field', async () => {
  const { seen, unmount } = await mountForm()
  try {
    const name = document.getElementById('name') as HTMLInputElement | null
    assert.ok(name, 'expected the display-name input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(name, '   ')
      name.dispatchEvent(new window.Event('input', { bubbles: true }))
      await tick()
    })
    await tick()
    await act(async () => {
      saveButton().click()
      await tick()
    })
    await tick()
    assert.deepEqual(seen, [], 'a blank name must never reach the API')
    assert.equal(name.getAttribute('aria-invalid'), 'true', 'the input exposes its invalid state')
    const alert = document.getElementById('name-error')
    assert.equal(alert?.getAttribute('role'), 'alert', 'the error persists as an alert, not only a toast')
    assert.equal(alert?.textContent, String(settingsCopy.validation?.nameRequired))
  } finally {
    await unmount()
  }
})

// CTRL-01: the vendor-bill release policy lives on Company Settings as an
// explicit opt-in (default off), with a warning while no approval flow is
// configured for vendor bills.
test('the approvals card exposes the vendor-bill requirement and the no-flow warning', async () => {
  const { unmount } = await mountForm()
  try {
    const box = document.getElementById('requireVendorBillApproval') as HTMLInputElement | null
    assert.ok(box, 'expected the vendor-bill approval requirement control')
    assert.equal(box.type, 'checkbox', 'the requirement is an explicit opt-in control, never a hidden default')
    assert.equal(box.checked, false, 'the requirement defaults off')
    // t.rich renders the <flows> tag as a link: strip tags to get the expectation.
    const plain = (key: string): string =>
      String(settingsCopy.approvals?.[key] ?? '').replace(/<\/?flows>/g, '')
    const warning = document.body.textContent ?? ''
    assert.ok(
      warning.includes(plain('noFlowWarningAuto')),
      'the card warns while no vendor-bill approval flow is configured',
    )
    const flows = [...document.querySelectorAll('a')].find((a) =>
      (a.textContent ?? '').includes('Flows'),
    ) as HTMLAnchorElement | undefined
    assert.equal(flows?.getAttribute('href'), '/admin/flows', 'the warning links the Flows setup surface')
    await act(async () => {
      box.click()
      await tick()
    })
    await tick()
    assert.ok(
      (document.body.textContent ?? '').includes(plain('noFlowWarningRequired')),
      'opting in rewords the warning to the refusal the submit path names',
    )
  } finally {
    await unmount()
  }
})

// IN11: the stock-count independent-review policy lives on the same
// Approvals card as an explicit opt-in (default off).
test('the approvals card exposes the stock-count independent-review requirement', async () => {
  const { unmount } = await mountForm()
  try {
    const box = document.getElementById('requireStockCountReview') as HTMLInputElement | null
    assert.ok(box, 'expected the stock-count review requirement control')
    assert.equal(box.checked, false, 'the requirement defaults off')
    assert.ok(
      (document.body.textContent ?? '').includes(String(settingsCopy.approvals?.requireStockCountReviewHint)),
      'the requirement explains both the on and the off behaviour',
    )
  } finally {
    await unmount()
  }
})

// TZ1: the org business time zone is settable on Company Settings — it offers
// the canonical zone list and saves the chosen zone.
test('the organization card exposes the business time zone picker', async () => {
  const { seen, unmount } = await mountForm()
  try {
    const trigger = document.querySelector(
      `button[aria-label="${String(settingsCopy.organization?.timeZone)}"]`,
    ) as HTMLButtonElement | null
    assert.ok(trigger, 'expected the business time-zone picker')
    await act(async () => {
      trigger.click()
      await tick()
    })
    await tick()
    const options = [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent ?? '')
    assert.ok(options.some((text) => text.includes('UTC')), 'the picker offers UTC')
    assert.ok(options.some((text) => text.includes('America/Toronto')), 'the picker offers the canonical zones')
    const toronto = [...document.querySelectorAll('[role="option"]')].find((el) =>
      (el.textContent ?? '').includes('America/Toronto'),
    ) as HTMLButtonElement | undefined
    assert.ok(toronto, 'expected an America/Toronto option')
    await act(async () => {
      toronto.click()
      await tick()
    })
    await tick()
    await act(async () => {
      saveButton().click()
      await tick()
      await tick()
    })
    await tick()
    assert.equal(seen.length, 1, 'the save must PUT once')
    assert.equal(
      (seen[0]!.body as Record<string, unknown>).timeZone,
      'America/Toronto',
      'the chosen zone travels with the save',
    )
  } finally {
    await unmount()
  }
})
