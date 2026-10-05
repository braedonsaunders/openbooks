import assert from 'node:assert/strict'
import test from 'node:test'
import { CONTROL_ACCOUNT_ROLES } from '@openbooks/engine/src/records/control-accounts.ts'

declare global {
  var __settingsRouter: { push(url: string): void; refresh(): void } | undefined
  var __settingsToasts: { kind: string; message: string }[] | undefined
}

// jsdom first: the form reads browser globals at render.
const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/settings', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__settingsRouter}export function usePathname(){return "/admin/settings"}export function useSearchParams(){return new URLSearchParams()}' })
registerHooks({
  resolve(specifier, context, next) {

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

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const settingsCopy = (await import('../../../../messages/en/admin.json', { with: { type: 'json' } })).default
  .settings as unknown as Record<string, Record<string, string>>
const { SaasMetricsNormalization } = await import('./SaasMetricsNormalization')
const normalizationCopy = (
  await import('../../../../messages/en/admin.json', { with: { type: 'json' } })
).default.settings.saasMetrics.normalization as unknown as Record<string, string> & {
  states: Record<string, string>
}
const { SettingsForm } = await import('./SettingsForm')
const contractCreationCopy = (
  await import('../../../../messages/en/admin.json', { with: { type: 'json' } })
).default.settings.revenue.contractCreation as unknown & {
  label: string
  firstBilling: string
  booking: string
}

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
  contractCreation: 'first_billing',
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
  controlAccountRoles: CONTROL_ACCOUNT_ROLES,
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

async function mountForm(
  initial: FormProps['initial'] = INITIAL,
  extraProps: Partial<Omit<FormProps, 'initial'>> = {},
) {
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
        <SettingsForm initial={initial} {...PROPS} {...extraProps} />
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

// clearing Display name and saving gave zero feedback — Save
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

// Contract creation belongs to scoped revenue contracts: the choice renders
// only while the switch is on, travels with the save, and stays out of the
// payload while off so the stored choice survives the toggle.
test('contract creation travels only while scoped contracts are on', async () => {
  const gated = await mountForm(INITIAL, { revenueRecognition: true, revenueContracts: true })
  try {
    const trigger = [...document.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes(String(contractCreationCopy.firstBilling)),
    ) as HTMLButtonElement | undefined
    assert.ok(trigger, 'expected the contract-creation picker while scoped contracts are on')
    await act(async () => {
      trigger.click()
      await tick()
    })
    await tick()
    const booking = [...document.querySelectorAll('[role="option"]')].find((el) =>
      (el.textContent ?? '').includes(String(contractCreationCopy.booking)),
    ) as HTMLButtonElement | undefined
    assert.ok(booking, 'expected a booking option')
    // Drive the picker's backing native select (its documented contract:
    // the genuine change event fires from the native control), which is the
    // seam this form owns — the picker's own suite covers option clicks.
    const native = [...document.querySelectorAll('select')].find((candidate) =>
      [...candidate.options].some((option) => option.value === 'booking'),
    )
    assert.ok(native, 'expected the backing native select')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(native, 'booking')
      native.dispatchEvent(new window.Event('change', { bubbles: true }))
      await tick()
    })
    await tick()
    await act(async () => {
      saveButton().click()
      await tick()
      await tick()
    })
    await tick()
    assert.equal(gated.seen.length, 1, 'the save must PUT once')
    assert.equal(
      (gated.seen[0]!.body as Record<string, unknown>).contractCreation,
      'booking',
      'the booking choice travels with the save',
    )
  } finally {
    await gated.unmount()
  }

  const ungated = await mountForm(INITIAL, { revenueRecognition: true })
  try {
    assert.equal(
      document.getElementById('contractCreation'),
      null,
      'no contract-creation control while scoped contracts are off',
    )
    await act(async () => {
      saveButton().click()
      await tick()
      await tick()
    })
    await tick()
    assert.equal(ungated.seen.length, 1, 'the save must PUT once')
    assert.ok(
      !('contractCreation' in ((ungated.seen[0]!.body as Record<string, unknown>) ?? {})),
      'the stored choice is left alone while the switch is off',
    )
  } finally {
    await ungated.unmount()
  }
})

// Normalization operator workflow: composed inside the existing SaaS Metrics
// card, reading only the authenticated API. Fetch is the one doubled
// boundary; translations, schemas, and the res.ok-first refusal handling
// stay real.

type WorkflowSeen = { url: string; method: string; body: unknown }

async function mountWorkflow(
  respond: (seen: WorkflowSeen) => Response | Promise<Response>,
) {
  const seen: WorkflowSeen[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const record: WorkflowSeen = {
      url: String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }
    seen.push(record)
    return respond(record)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SaasMetricsNormalization />
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

function setWorkflowInput(id: string, value: string) {
  const field = document.getElementById(id) as HTMLInputElement | null
  assert.ok(field, `expected input #${id}`)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(field, value)
  field.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function clickWorkflowButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
  assert.ok(button, `expected a "${label}" button`)
  return button
}

const FAILED_MONTH = [
  {
    month: '2026-07-01',
    state: 'failed',
    counts: { monthly: 1, facts: 1, cohorts: 1 },
    denominationVersion: null,
    reportingCurrency: null,
    request: { id: 'request-1', status: 'failed' },
    failure: 'Month 2026-07-01 changed under its correction; the proven row counts no longer match.',
    remedy: 'Retry the request in Company Setup → SaaS Metrics; every metric write was rolled back.',
  },
]

test('normalization evidence renders accessible month rows with only pending approval actions', async () => {
  const ready = {
    month: '2026-06-01',
    state: 'ready',
    counts: { monthly: 4, facts: 12, cohorts: 2 },
    denominationVersion: 'v3',
    reportingCurrency: 'CAD',
    request: null,
    failure: null,
    remedy: null,
  }
  const pending = {
    month: '2026-08-01',
    state: 'pending',
    counts: { monthly: 3, facts: 8, cohorts: 1 },
    denominationVersion: null,
    reportingCurrency: null,
    request: { id: 'request-august', status: 'pending' },
    failure: null,
    remedy: null,
  }
  const { seen, unmount } = await mountWorkflow((record) => record.method === 'POST'
    ? Response.json({
        error: 'Request request-august needs a different approver.',
        remedy: 'Have another authorized approver review August in Company Setup → SaaS Metrics.',
      }, { status: 409 })
    : Response.json([ready, FAILED_MONTH[0], pending]))
  try {
    const table = document.querySelector('table')
    assert.ok(table, 'the month evidence uses a semantic table')
    const headings = [...table.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim())
    assert.deepEqual(headings, [
      normalizationCopy.monthColumn,
      normalizationCopy.statusColumn,
      normalizationCopy.countsColumn,
      normalizationCopy.approveSubmit,
    ])
    const rows = [...table.querySelectorAll('tbody tr')] as HTMLTableRowElement[]
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map((row) => row.cells[0]?.textContent), ['2026-06-01', '2026-07-01', '2026-08-01'])
    assert.match(rows[0]!.cells[1]!.textContent ?? '', /v3.*CAD/)
    assert.match(rows[0]!.cells[2]!.textContent ?? '', /4 \/ 12 \/ 2/)
    assert.match(rows[1]!.cells[1]!.textContent ?? '', /the proven row counts no longer match/)
    assert.match(rows[1]!.cells[1]!.textContent ?? '', /Company Setup → SaaS Metrics/)
    assert.match(rows[2]!.cells[1]!.textContent ?? '', /request-august/)
    const action = rows[2]!.querySelector('button')
    assert.ok(action, 'only the pending month offers approval')
    assert.equal(rows[0]!.querySelector('button'), null)
    assert.equal(rows[1]!.querySelector('button'), null)
    action.focus()
    assert.equal(document.activeElement, action, 'the approval remains a native focusable button')
    await act(async () => {
      action.click()
      await tick()
    })
    assert.ok(seen.some((entry) => entry.method === 'POST' && entry.url.endsWith('/request-august/approve')))
    assert.match(document.body.textContent ?? '', /another authorized approver review August/)
  } finally {
    await unmount()
  }
})

test('normalization empty state keeps the correction form available', async () => {
  const { unmount } = await mountWorkflow(() => Response.json([]))
  try {
    assert.equal(document.querySelector('table'), null)
    assert.ok(document.body.textContent?.includes(String(normalizationCopy.empty)))
    assert.ok(document.getElementById('normalization-month'))
    assert.ok(document.getElementById('normalization-reason'))
    assert.ok(clickWorkflowButton(String(normalizationCopy.requestSubmit)))
  } finally {
    await unmount()
  }
})

test('a failed month reads with its exact failure and remedy, never a bare state', async () => {
  const { unmount } = await mountWorkflow(() => Response.json(FAILED_MONTH))
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.states.failed)),
      'the failed state must render',
    )
    assert.ok(
      document.body.textContent?.includes('the proven row counts no longer match'),
      'the recorded failure text must read verbatim',
    )
    assert.ok(
      document.body.textContent?.includes('Company Setup → SaaS Metrics'),
      'the recorded remedy must name the Setup surface',
    )
  } finally {
    await unmount()
  }
})

test('a non-JSON error renders the load fallback, never a parse error', async () => {
  const { unmount } = await mountWorkflow(
    () => new Response('Internal Server Error', { status: 500 }),
  )
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.loadFailed)),
      'the load fallback must render when the body cannot be parsed',
    )
    assert.ok(
      !document.body.textContent?.includes('Unexpected token'),
      'a JSON parse error must never reach the operator',
    )
  } finally {
    await unmount()
  }
})

test('submitting a request posts one month, a reason, and a uuid key, then reloads', async () => {
  const uuid = '00000000-0000-4000-8000-000000000003'
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => uuid },
    configurable: true,
  })
  let gets = 0
  const { seen, unmount } = await mountWorkflow((record) => {
    if (record.method === 'POST') {
      return Response.json({ request: { id: 'request-1', status: 'pending' }, created: true }, { status: 201 })
    }
    gets += 1
    return Response.json(
      gets > 1
        ? [
            {
              month: '2026-07-01',
              state: 'pending',
              counts: { monthly: 1, facts: 1, cohorts: 1 },
              denominationVersion: null,
              reportingCurrency: null,
              request: { id: 'request-1', status: 'pending' },
              failure: null,
              remedy: null,
            },
          ]
        : [],
    )
  })
  try {
    await act(async () => {
      setWorkflowInput('normalization-month', '2026-07-01')
      await tick()
    })
    await act(async () => {
      setWorkflowInput('normalization-reason', 'Correct the July legacy denomination.')
      await tick()
    })
    await act(async () => {
      clickWorkflowButton(String(normalizationCopy.requestSubmit)).click()
      await tick()
      await tick()
    })
    await tick()
    const post = seen.find((entry) => entry.method === 'POST')
    assert.deepEqual(
      post?.body,
      { month: '2026-07-01', reason: 'Correct the July legacy denomination.', idempotencyKey: uuid },
      'the request posts exactly one month, the reason, and the uuid key',
    )
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.states.pending)),
      'the reloaded list must show the pending month',
    )
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
    await unmount()
  }
})

test('approving a pending month posts to its approve URL and surfaces a refusal remedy', async () => {
  const pending = [
    {
      month: '2026-07-01',
      state: 'pending',
      counts: { monthly: 1, facts: 1, cohorts: 1 },
      denominationVersion: null,
      reportingCurrency: null,
      request: { id: 'request-1', status: 'pending' },
      failure: null,
      remedy: null,
    },
  ]
  const { seen, unmount } = await mountWorkflow((record) => {
    if (record.method === 'POST') {
      return Response.json(
        {
          error: 'Request request-1 cannot be approved by its requester.',
          code: 'saas_normalization_self_approval',
          remedy: 'Have a different authorized approver approve the request in Company Setup → SaaS Metrics.',
        },
        { status: 409 },
      )
    }
    return Response.json(pending)
  })
  try {
    await act(async () => {
      clickWorkflowButton(String(normalizationCopy.approveSubmit)).click()
      await tick()
      await tick()
    })
    await tick()
    assert.ok(
      seen.some(
        (entry) =>
          entry.method === 'POST' &&
          entry.url === '/api/metrics/normalization/requests/request-1/approve',
      ),
      'approval posts to the request approve URL with no body',
    )
    assert.ok(
      document.body.textContent?.includes('different authorized approver'),
      'the self-approval remedy must read verbatim after res.ok fails',
    )
  } finally {
    await unmount()
  }
})

test('the SaaS Metrics card hosts the workflow only while the feature is on', async () => {
  const mountSettings = async (saasMetricsEnabled: boolean) => {
    const prior = globalThis.fetch
    globalThis.fetch = (async () => Response.json([])) as typeof fetch
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <SettingsForm initial={INITIAL} {...PROPS} saasMetricsEnabled={saasMetricsEnabled} />
        </NextIntlClientProvider>,
      )
      await tick()
    })
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
  const off = await mountSettings(false)
  try {
    assert.ok(
      !document.body.textContent?.includes(String(normalizationCopy.title)),
      'no workflow surface may render while the feature is off',
    )
  } finally {
    await off.unmount()
  }
  const on = await mountSettings(true)
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.title)),
      'the existing card hosts the workflow while the feature is on',
    )
  } finally {
    await on.unmount()
  }
})

test('a non-JSON request error renders the request fallback, never a parse error', async () => {
  const { unmount } = await mountWorkflow((record) => {
    if (record.method === 'POST') return new Response('Internal Server Error', { status: 500 })
    return Response.json([])
  })
  try {
    await act(async () => {
      setWorkflowInput('normalization-month', '2026-07-01')
      await tick()
    })
    await act(async () => {
      setWorkflowInput('normalization-reason', 'Correct the July legacy denomination.')
      await tick()
    })
    await act(async () => {
      clickWorkflowButton(String(normalizationCopy.requestSubmit)).click()
      await tick()
      await tick()
    })
    await tick()
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.requestFailed)),
      'the request fallback must render when the error body cannot be parsed',
    )
    assert.ok(
      !document.body.textContent?.includes('Unexpected token'),
      'a JSON parse error must never reach the operator',
    )
  } finally {
    await unmount()
  }
})

test('a non-JSON approval error renders the approval fallback', async () => {
  const pending = [
    {
      month: '2026-07-01',
      state: 'pending',
      counts: { monthly: 1, facts: 1, cohorts: 1 },
      denominationVersion: null,
      reportingCurrency: null,
      request: { id: 'request-1', status: 'pending' },
      failure: null,
      remedy: null,
    },
  ]
  const { unmount } = await mountWorkflow((record) => {
    if (record.method === 'POST') return new Response('Internal Server Error', { status: 500 })
    return Response.json(pending)
  })
  try {
    await act(async () => {
      clickWorkflowButton(String(normalizationCopy.approveSubmit)).click()
      await tick()
      await tick()
    })
    await tick()
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.approveFailed)),
      'the approval fallback must render when the error body cannot be parsed',
    )
  } finally {
    await unmount()
  }
})

test('a rejected load renders the load fallback instead of rejecting', async () => {
  const { unmount } = await mountWorkflow(() => {
    throw new Error('connection lost')
  })
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.loadFailed)),
      'a fetch rejection must surface the load fallback',
    )
  } finally {
    await unmount()
  }
})

test('an unchanged retry reuses its key while a changed body rotates', async () => {
  let sequence = 0
  const nextKey = () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, '0')}`
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: nextKey }, configurable: true })
  const { seen, unmount } = await mountWorkflow((record) => {
    if (record.method === 'POST') return new Response('Internal Server Error', { status: 500 })
    return Response.json([])
  })
  try {
    await act(async () => {
      setWorkflowInput('normalization-month', '2026-07-01')
      await tick()
    })
    await act(async () => {
      setWorkflowInput('normalization-reason', 'Correct the July legacy denomination.')
      await tick()
    })
    const submit = async () => {
      await act(async () => {
        clickWorkflowButton(String(normalizationCopy.requestSubmit)).click()
        await tick()
        await tick()
      })
      await tick()
    }
    await submit()
    await submit()
    const posts = seen.filter((entry) => entry.method === 'POST')
    assert.equal(posts.length, 2, 'both retries must post')
    assert.equal(
      (posts[0]!.body as Record<string, unknown>).idempotencyKey,
      (posts[1]!.body as Record<string, unknown>).idempotencyKey,
      'an unchanged retry after a lost response must reuse the same key',
    )
    await act(async () => {
      setWorkflowInput('normalization-reason', 'Correct the July legacy denomination twice.')
      await tick()
    })
    await submit()
    const rotated = seen.filter((entry) => entry.method === 'POST')
    assert.equal(rotated.length, 3, 'the changed draft must post again')
    assert.notEqual(
      (rotated[2]!.body as Record<string, unknown>).idempotencyKey,
      (rotated[0]!.body as Record<string, unknown>).idempotencyKey,
      'a changed body must rotate to a fresh key',
    )
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
    await unmount()
  }
})

test('a conclusive success consumes its draft key', async () => {
  let sequence = 100
  const nextKey = () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, '0')}`
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: nextKey }, configurable: true })
  const { seen, unmount } = await mountWorkflow((record) => {
    if (record.method === 'POST') {
      return Response.json({ request: { id: 'request-1', status: 'pending' }, created: true }, { status: 201 })
    }
    return Response.json([])
  })
  const fillSameDraft = async () => {
    await act(async () => {
      setWorkflowInput('normalization-month', '2026-07-01')
      await tick()
    })
    await act(async () => {
      setWorkflowInput('normalization-reason', 'Correct the July legacy denomination.')
      await tick()
    })
    await act(async () => {
      clickWorkflowButton(String(normalizationCopy.requestSubmit)).click()
      await tick()
      await tick()
    })
    await tick()
  }
  try {
    await fillSameDraft()
    await fillSameDraft()
    const posts = seen.filter((entry) => entry.method === 'POST')
    assert.equal(posts.length, 2, 'both submissions must post')
    assert.notEqual(
      (posts[0]!.body as Record<string, unknown>).idempotencyKey,
      (posts[1]!.body as Record<string, unknown>).idempotencyKey,
      'a conclusive success must rotate the draft key even for the same body',
    )
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
    await unmount()
  }
})

test('a ready month renders its recorded denomination and currency', async () => {
  const { unmount } = await mountWorkflow(() =>
    Response.json([
      {
        month: '2026-07-01',
        state: 'ready',
        counts: { monthly: 1, facts: 1, cohorts: 1 },
        denominationVersion: 'v1',
        reportingCurrency: 'CAD',
        request: { id: 'request-1', status: 'succeeded' },
        failure: null,
        remedy: null,
      },
    ]),
  )
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.resultDenomination)),
      'the recorded denomination label must render',
    )
    assert.ok(document.body.textContent?.includes('v1'), 'the recorded denomination must render')
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.resultCurrency)),
      'the recorded currency label must render',
    )
    assert.ok(document.body.textContent?.includes('CAD'), 'the recorded currency must render')
  } finally {
    await unmount()
  }
})
