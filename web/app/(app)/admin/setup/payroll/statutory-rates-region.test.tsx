import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __ratesRouter: { push(url: string): void; refresh(): void } | undefined
  var __ratesToasts: { kind: string; message: string }[] | undefined
}

// jsdom first: the section reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/payroll',
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__ratesRouter}export function usePathname(){return "/admin/setup/payroll"}export function useSearchParams(){return new URLSearchParams()}',
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
        url: `data:text/javascript,export const toast={success(m){(globalThis.__ratesToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__ratesToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}`,
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
const messages = (await import('../../../../../messages/en')).default
const settingsPage = (await import('../../../../../messages/en/payroll.json', { with: { type: 'json' } })).default
  .settingsPage as unknown as Record<string, Record<string, string>>
const { StatutoryRatesSection } = await import('./StatutoryRatesSection')
const { BusinessDateProvider } = await import('../../../../../components/business-date-provider')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const SLOT = {
  key: 'eit',
  label: 'EI Tax',
  scope: 'region',
  programType: null,
  regions: ['CA-ON'],
  citation: 'Test statute s.1',
  variesBecause: '',
  systemKeys: [],
  fields: [
    {
      key: 'rate',
      label: 'Effective rate',
      kind: 'rate',
      decimals: 4,
      min: '0',
      max: '1',
      required: true,
      help: '',
    },
  ],
}

const PAYLOAD = {
  year: 2026,
  installed: ['XX'],
  packs: [
    {
      country: 'XX',
      regionLabel: 'state',
      knownRegions: ['CA-ON'],
      slots: [SLOT],
      accounts: [],
    },
  ],
  rows: [
    {
      id: 'row-1',
      country: 'XX',
      rateKey: 'eit',
      region: 'CA-ON',
      subRegion: null,
      filingAccountId: null,
      accountNumber: null,
      accountName: null,
      taxYear: 2026,
      values: { rate: '0.0060' },
    },
  ],
  gaps: [],
  coverage: [],
}

async function mountRates(putResponder: () => Response | Promise<Response>) {
  globalThis.__ratesRouter = { push() {}, refresh() {} }
  globalThis.__ratesToasts = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.startsWith('/api/payroll/settings/rates') && method === 'GET') return Response.json(PAYLOAD)
    if (url === '/api/payroll/settings/rates' && method === 'PUT') return putResponder()
    return Response.json({})
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-05-01">
          <StatutoryRatesSection initialYear={2026} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  await tick()
  return {
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      globalThis.fetch = prior
    },
  }
}

function setInputById(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null
  assert.ok(input, `expected an input #${id}`)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function openDialog() {
  const add = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(String(settingsPage.rates?.add ?? 'Add a rate')),
  ) as HTMLButtonElement | undefined
  assert.ok(add, 'the section must offer to add a rate')
  await act(async () => {
    add.click()
    await tick()
  })
  await tick()
}

test('the rates table renders decimal rates as percents', async () => {
  const { unmount } = await mountRates(() => Response.json({ ok: true }))
  try {
    assert.ok(
      (document.body.textContent ?? '').includes('0.60%'),
      'the stored decimal 0.0060 must read as a human percent',
    )
  } finally {
    await unmount()
  }
})

test('the rate dialog labels the region picker from the pack, capitalized', async () => {
  const { unmount } = await mountRates(() => Response.json({ ok: true }))
  try {
    await openDialog()
    const label = document.querySelector('label[for="rate-region"]')
    assert.ok(label, 'the dialog must label its region picker')
    assert.match(label?.textContent ?? '', /State/, 'the pack region token renders capitalized')
    assert.doesNotMatch(label?.textContent ?? '', /\bstate\b/, 'the raw token never shows')
  } finally {
    await unmount()
  }
})

test('rate inputs name their scale and range from the declaration', async () => {
  const { unmount } = await mountRates(() => Response.json({ ok: true }))
  try {
    await openDialog()
    const body = document.body.textContent ?? ''
    assert.ok(
      body.includes(String(settingsPage.rates?.rateScaleHint ?? 'Decimal rate')),
      'a decimal-rate input names its scale',
    )
    assert.ok(body.includes('0–1'), 'the input names the accepted range from the declaration')
  } finally {
    await unmount()
  }
})

test('the rate dialog keeps the save rejection visible inside the drawer', async () => {
  const refusal = 'region CA-ON is not open for 2026'
  const { unmount } = await mountRates(() => Response.json({ error: refusal }, { status: 422 }))
  try {
    await openDialog()
    setInputById('rate-field-rate', '0.0060')
    await tick()
    const save = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Save',
    ) as HTMLButtonElement | undefined
    assert.ok(save, 'the dialog must offer Save')
    await act(async () => {
      save.click()
      await tick()
      await tick()
    })
    await tick()
    const alert = [...document.querySelectorAll('div')].find((el) =>
      (el.textContent ?? '').includes(refusal),
    )
    assert.ok(alert, 'the rejection stays rendered inside the drawer until the next save')
    assert.ok(
      [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === 'Save'),
      'the drawer stays open on rejection',
    )
  } finally {
    await unmount()
  }
})
