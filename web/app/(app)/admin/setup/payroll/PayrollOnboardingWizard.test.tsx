import assert from 'node:assert/strict'
import test from 'node:test'
import { isUuid } from '../../../../../lib/list-params'

declare global {
  var __payrollWizRouter: { push(url: string): void; refresh(): void } | undefined
  var __payrollWizToasts: { kind: string; message: string }[] | undefined
}

// jsdom first: the wizard reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/payroll',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
// Reduced-motion matches so step transitions swap synchronously: jsdom
// never completes the exit tween that AnimatePresence mode="wait" holds the
// next step behind.
window.matchMedia = ((query: string) => ({
  matches: String(query).includes('reduce'),
  media: String(query),
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia
if (typeof window.requestAnimationFrame !== 'function') {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__payrollWizRouter}export function usePathname(){return "/admin/setup/payroll"}export function useSearchParams(){return new URLSearchParams()}',
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
        url: `data:text/javascript,export const toast={success(m){(globalThis.__payrollWizToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__payrollWizToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}`,
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
const wizardCopy = (await import('../../../../../messages/en/payroll.json', { with: { type: 'json' } })).default
  .setupWizard as Record<string, unknown>
const RAILS_TITLE = String(
  ((wizardCopy.rails as Record<string, string> | undefined)?.title ?? 'Pay rails'),
)
const { PayrollOnboardingWizard } = await import('./PayrollOnboardingWizard')
const { SETUP_ENTITY_BY_KEY } = await import('../../../../../lib/setup/registry')

type WizardProps = Parameters<typeof PayrollOnboardingWizard>[0]

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
// Step transitions lock briefly against double-clicks; the walk waits it out.
const STEP_WAIT = 500

// The loader derives these from the pay-schedules registry entity, exactly
// as sections.tsx does — the wizard never declares frequencies itself.
const FREQUENCIES = (SETUP_ENTITY_BY_KEY.get('pay-schedules')?.fields.find((f) => f.key === 'frequency')?.options ?? [])
  .filter((option): option is { value: string; labelKey: string } => Boolean(option.labelKey))
  .map((option) => ({ value: option.value, labelKey: option.labelKey }))

const PAYLOAD = {
  settings: { wageExpenseAccountId: null, netPayAccountId: null },
  packs: [{ country: 'XX', name: 'Xenonia Payroll', slots: [] }],
  paymentMethods: { eftFallbackToCheque: true },
  installable: ['XX'],
  installablePacks: [{ country: 'XX', name: 'Xenonia Payroll' }],
  accounts: [],
  vendors: [],
  setup: { installedCountries: [], checks: [], blockers: 0, warnings: 0 },
}

interface SeenRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

async function mountWizard(scheduleResponder: () => Response | Promise<Response>) {
  globalThis.__payrollWizRouter = { push() {}, refresh() {} }
  globalThis.__payrollWizToasts = []
  const seen: SeenRequest[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url === '/api/payroll/settings' && method === 'GET') return Response.json(PAYLOAD)
    if (url === '/api/admin/setup/pay-schedules') {
      const headers = new Headers(init?.headers)
      seen.push({ url, method, headers: Object.fromEntries(headers.entries()), body: JSON.parse(String(init?.body)) })
      return scheduleResponder()
    }
    return Response.json({ ok: true })
  }) as typeof fetch
  const props: WizardProps = {
    onClose() {},
    vendorKeysByCountry: {},
    frequencies: FREQUENCIES,
    canManageEntities: true,
    schedules: [],
    subsidiaries: [{ id: 'sub-1', name: 'Main' }],
    bankProfiles: [],
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PayrollOnboardingWizard {...props} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick(600)
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

function nextButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === String(wizardCopy.next),
  ) as HTMLButtonElement | undefined
  assert.ok(button, `expected a Next button (copy: ${String(wizardCopy.next)})`)
  return button
}

async function goNext() {
  assert.equal(nextButton().disabled, false, 'Next must be enabled on this step')
  await act(async () => {
    nextButton().click()
  })
  await tick(STEP_WAIT)
}

function setInput(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null
  assert.ok(input, `expected an input #${id}`)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function walkToSchedule() {
  const pack = [...document.querySelectorAll('button[aria-pressed]')].find((b) =>
    (b.textContent ?? '').includes('Xenonia Payroll'),
  ) as HTMLButtonElement | undefined
  assert.ok(pack, 'the packs step must offer the server-declared pack')
  await act(async () => {
    pack.click()
  })
  await tick()
  await goNext() // packs → accounts (installs the pack)
  await goNext() // accounts → schedule
}

test('the wizard offers the packs the server declares, named by the packs', async () => {
  const { unmount } = await mountWizard(() => Response.json({ ok: true, id: 'sched-1' }))
  try {
    const cards = [...document.querySelectorAll('button[aria-pressed]')]
    assert.equal(cards.length, 1, 'the wizard offers exactly what the settings API declares')
    assert.ok(
      (cards[0]?.textContent ?? '').includes('Xenonia Payroll'),
      'the pack reads under its served name, never a bare country code',
    )
    assert.ok(
      !(document.body.textContent ?? '').includes('packs.canada'),
      'no pack renders through a hardcoded i18n map',
    )
  } finally {
    await unmount()
  }
})

test('the pay-schedule create sends an Idempotency-Key', async () => {
  const { seen, unmount } = await mountWizard(() => Response.json({ ok: true, id: 'sched-1' }))
  try {
    await walkToSchedule()
    await act(async () => {
      setInput('pw-schedule-name', 'Biweekly HQ')
      setInput('pw-schedule-anchor', '2026-01-16')
    })
    await tick()
    await goNext() // schedule → rails (commits the create)
    const posts = seen.filter((request) => request.method === 'POST')
    assert.equal(posts.length, 1, 'leaving the schedule step creates the schedule once')
    const key = posts[0]!.headers['idempotency-key'] ?? ''
    assert.ok(isUuid(key), 'the create carries a UUID Idempotency-Key')
    assert.equal((posts[0]!.body as Record<string, unknown>).name, 'Biweekly HQ')
    assert.ok(
      (document.body.textContent ?? '').includes(RAILS_TITLE),
      'the committed schedule advances the walk to the rails step',
    )
  } finally {
    await unmount()
  }
})

test('the key is stable per attempt, minted once and kept across retries', async () => {
  let attempts = 0
  const { seen, unmount } = await mountWizard(() => {
    attempts += 1
    if (attempts === 1) return Response.json({ error: 'ambiguous write' }, { status: 500 })
    return Response.json({ ok: true, id: 'sched-1' })
  })
  try {
    await walkToSchedule()
    await act(async () => {
      setInput('pw-schedule-name', 'Biweekly HQ')
      setInput('pw-schedule-anchor', '2026-01-16')
    })
    await tick()
    await goNext() // first attempt fails ambiguously; the wizard stays put
    assert.equal(attempts, 1, 'the first attempt must fire')
    await goNext() // retry replays the same create
    const posts = seen.filter((request) => request.method === 'POST')
    assert.equal(posts.length, 2, 'the retry replays the create instead of abandoning it')
    assert.ok(
      isUuid(posts[0]!.headers['idempotency-key'] ?? ''),
      'the attempt carries a UUID key in the first place',
    )
    assert.equal(
      posts[1]!.headers['idempotency-key'],
      posts[0]!.headers['idempotency-key'],
      'the retry reuses the minted key — a fresh key per click would mint a duplicate schedule',
    )
  } finally {
    await unmount()
  }
})
