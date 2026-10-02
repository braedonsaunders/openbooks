import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { isUuid } from '../../../../../lib/list-params'

declare global {
  var __setupDrawerRouter: { push(url: string): void; replace(url: string): void; refresh(): void } | undefined
  var __setupDrawerToasts: { kind: string; message: string }[] | undefined
}

// jsdom first: the drawer reads browser globals at render.
const { bootJsdomEnvironment } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/setup/account-groups?row=new', matchMediaMatches: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__setupDrawerRouter}export function usePathname(){return \'/admin/setup/account-groups\'}export function useSearchParams(){return new URLSearchParams(globalThis.__setupDrawerQuery ?? \'\')}' })
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast={success(m){(globalThis.__setupDrawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__setupDrawerToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__setupDrawerToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}`,
      }
    }
    if (specifier === '@/app/(app)/accounting/changes/LossOfControlButton') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function LossOfControlButton(){return null}',
      }
    }
    return next(specifier, context)
  },
})

declare global {
  var __setupDrawerQuery: string | undefined
}

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const adminCatalog = (await import('../../../../../messages/en/admin.json', { with: { type: 'json' } })).default
  .setup as unknown as Record<string, Record<string, string>>
const commonCatalog = (await import('../../../../../messages/en/common.json', { with: { type: 'json' } })).default as unknown as Record<
  string,
  Record<string, string>
>
const { SetupDrawer } = await import('./SetupDrawer')
const { benefitPlanPresentation } = await import('../../../../../lib/setup/hrm-benefits')
const { SETUP_ENTITY_BY_KEY } = await import('../../../../../lib/setup/registry')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const ENTITY_KEY = 'account-groups'
const FIELD_LABEL = adminCatalog.fields as Record<string, string>
const requiredCopy = (fieldLabel: string): string =>
  String(adminCatalog.validation?.required ?? '').replace('{field}', fieldLabel)

interface SeenRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

async function mountDrawer(
  t: TestContext,
  row: Record<string, unknown> | null,
  responder: (seen: SeenRequest[]) => Response | Promise<Response>,
  entityKey: string = ENTITY_KEY,
  initialValues?: Record<string, unknown>,
  mutationBasePath?: string,
  presentation?: ReturnType<typeof benefitPlanPresentation>,
) {
  const entity = presentation ?? SETUP_ENTITY_BY_KEY.get(entityKey)
  assert.ok(entity, `the registry must declare ${entityKey}`)
  const pushes: string[] = []
  globalThis.__setupDrawerRouter = {
    push(url: string) {
      pushes.push(url)
    },
    replace() {},
    refresh() {},
  }
  globalThis.__setupDrawerToasts = []
  const seen: SeenRequest[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    let body: unknown = null
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null
    } catch {
      body = null
    }
    seen.push({
      url: String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(headers.entries()),
      body,
    })
    return responder(seen)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SetupDrawer entity={entity} row={row} members={[]} refOptions={{}} initialValues={initialValues} mutationBasePath={mutationBasePath} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = prior
  })
  return { pushes, seen }

}

function setTextInput(label: string, value: string) {
  const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null
  assert.ok(input, `expected a text input labelled ${label}`)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function clickButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === name,
  ) as HTMLButtonElement | undefined
  assert.ok(button, `expected a ${name} button`)
  return button
}

async function clickSave(create: boolean) {
  const name = create ? String(commonCatalog.actions?.create) : String(commonCatalog.actions?.save)
  await act(async () => {
    clickButton(name).click()
    await tick()
    await tick()
  })
  await tick()
}

function alertText(): string | null {
  return document.querySelector('p[role="alert"]')?.textContent ?? null
}

async function fillValidCreate() {
  await act(async () => {
    setTextInput(FIELD_LABEL.key!, 'grp-1')
    setTextInput(FIELD_LABEL.name!, 'Group One')
    setTextInput(FIELD_LABEL.dimension!, 'department')
  })
  await tick()
}

test('required setup fields are visibly marked, and only those validate enforces', async (t) => {
  await mountDrawer(t, null, () => Response.json({ ok: true }))
  const labels = [...document.querySelectorAll('label')].map((el) => el.textContent ?? '')
  for (const [keys, required] of [[['key', 'name', 'dimension'], true], [['sortOrder', 'isActive'], false]] as const) {
    for (const key of keys) {
      const label = labels.find((text) => text.startsWith(FIELD_LABEL[key]!))
      assert.ok(label, `expected a label for ${key}`)
      assert.equal(label.endsWith('*'), required, `${key} marker must match whether its blank blocks saving`)
    }
  }
})

test('a blank required save keeps an inline alert naming the field, with no write', async (t) => {
  const { seen } = await mountDrawer(t, null, () => Response.json({ ok: true }))
  await clickSave(true)
  assert.deepEqual(seen, [], 'a blocked save must not reach the API')
  assert.equal(alertText(), requiredCopy(FIELD_LABEL.key!), 'the alert names the first missing field')
})

const ownershipValues = {
  parentSubsidiaryId: 'sub-parent',
  subsidiaryId: 'sub-child',
  effectiveFrom: '2026-01-01',
  ownershipPercent: '80',
  acquisitionDate: '2026-01-02',
  investmentAccountId: 'acc-invest',
  equityIncomeAccountId: 'acc-equity',
}
const savedOwnership = () => Response.json({ ok: true, id: 'own-1' })

test('blank keepDefault fields never block saving', async (t) => {
  // account-groups.sortOrder is keepDefault but NOT required, so it cannot
  // prove the branch: subsidiary-ownership-interests declares required AND
  // keepDefault together (method, acquisitionCost, acquisitionRate, …) with
  // the server applying its DB default to blanks. Every one of those stays
  // blank here; the save must still POST.
  const { seen, pushes } = await mountDrawer(t, null, savedOwnership, 'subsidiary-ownership-interests', ownershipValues)
  await clickSave(true)
  assert.equal(seen.length, 1, 'blank keepDefault fields must not block the create')
  assert.equal(seen[0]!.method, 'POST')
  assert.deepEqual(pushes.length, 1, 'a successful create navigates home')
})

test('a failed transport releases the button with an inline error', async (t) => {
  await mountDrawer(t, null, () => {
    throw new Error('down')
  })
  await fillValidCreate()
  await clickSave(true)
  assert.equal(alertText(), String(commonCatalog.feedback?.saveFailed), 'the transport failure names itself inline')
  assert.equal(
    clickButton(String(commonCatalog.actions?.create)).disabled,
    false,
    'the Create button must release after a transport failure',
  )
})

for (const [name, body, status, expected, message] of [
  [
    'typed server conflicts resolve through their code, never the raw message',
    { error: 'a server-worded human message', code: 'duplicate' },
    409,
    String(adminCatalog.errors?.duplicate),
    'a duplicate maps to localized copy',
  ],
  [
    'typed validation failures render their message verbatim',
    { error: 'Code must be lowercase with no spaces', code: 'invalid' },
    400,
    'Code must be lowercase with no spaces',
    'an invalid refusal names its fix verbatim',
  ],
  [
    'server required-field refusals render through the field label',
    { error: 'name is required', code: 'invalid' },
    400,
    requiredCopy(FIELD_LABEL.name!),
    'the server refusal renders exactly like client-side validate()',
  ],
  [
    'exclusion-conflict 409s resolve through the overlap code, never raw Postgres',
    { error: 'conflicting key value violates exclusion constraint', code: 'overlap' },
    409,
    String(adminCatalog.errors?.overlap),
    'an overlap maps to localized copy',
  ],
] as Array<[string, Record<string, string>, number, string, string]>) {
  test(name, async (t) => {
    await mountDrawer(t, null, () => Response.json(body, { status }))
    await fillValidCreate()
    await clickSave(true)
    assert.equal(alertText(), expected, message)
  })
}

test('creates mint one idempotency key per mounted session and reuse it across retries', async (t) => {
  let attempt = 0
  const { seen } = await mountDrawer(t, null, () => {
    attempt += 1
    if (attempt === 1) throw new Error('ambiguous failure')
    return Response.json({ ok: true, id: 'ag-1' })
  })
  await fillValidCreate()
  await clickSave(true)
  assert.equal(clickButton(String(commonCatalog.actions?.create)).disabled, false, 'the retry must be clickable')
  await clickSave(true)
  const posts = seen.filter((request) => request.method === 'POST')
  assert.equal(posts.length, 2, 'the retry replays the create')
  const first = posts[0]!.headers['idempotency-key'] ?? ''
  assert.ok(isUuid(first), 'the create carries a UUID idempotency key')
  assert.equal(posts[1]!.headers['idempotency-key'], first, 'the retry reuses the session key, never a fresh one')
})

for (const [input, expected, message] of [
  ['.5', '0.5', 'a typed decimal posts canonically'],
  ['12,34', '12,34', 'unparseable text reaches the authoritative server refusal unchanged'],
] as const) {
  test(`decimal inputs preserve ${input} through the native save`, async (t) => {
    const { seen } = await mountDrawer(t, null, savedOwnership, 'subsidiary-ownership-interests', ownershipValues)
    await act(async () => setTextInput(FIELD_LABEL.ownershipPercent!, input!))
    await tick()
    await clickSave(true)
    assert.equal(seen.length, 1, 'the save reaches the native API once')
    assert.equal((seen[0]!.body as Record<string, unknown>).ownershipPercent, expected, message)
  })
}

test('the idempotency key travels only on create POSTs, never on PATCH', async (t) => {
  const row = {
    id: 'ag-1',
    key: 'grp-1',
    name: 'Group One',
    dimension: 'department',
    color: '',
    sortOrder: 1,
    isActive: true,
  }
  const { seen } = await mountDrawer(t, row, () => Response.json({ ok: true }))
  await clickSave(false)
  assert.equal(seen.length, 1, 'the edit must save once')
  assert.equal(seen[0]!.method, 'PATCH')
  assert.ok(!('idempotency-key' in seen[0]!.headers), 'an edit must never replay as a create')
})

test('command-owned entities save through their setup command', async (t) => {
  const { seen } = await mountDrawer(t, null, () => Response.json({ ok: true }), 'fund-pairs', { fromFundId: '1', toFundId: '2', dueFromAccountId: '3', dueToAccountId: '4', reason: 'r' })
  await clickSave(true)
  assert.deepEqual([seen[0]?.method, seen[0]?.url], ['POST', '/api/admin/setup/fund-pairs/command'])
})


for (const kind of ['health', 'retirement'] as const) {
test(`${kind} guided creation uses the Benefits adapter and retains request identity across a refusal`, async (t) => {
  const { seen } = await mountDrawer(t, null,
    () => Response.json({ error: 'Choose a payroll component in this legal entity.' }, { status: 422 }),
    'benefit-plans', {
      code: 'HEALTH', name: 'Health coverage', kind, currency: 'USD',
      effectiveFrom: '2026-01-01',
    }, '/api/hrm/benefit-plan-configuration', benefitPlanPresentation(kind))
  const shell = document.querySelector('[role="dialog"]')
  assert.ok(!Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === commonCatalog.actions!.create))
  for (let step = 0; step < 2; step++) { await act(async () => clickButton(commonCatalog.actions!.next!).click()); assert.equal(document.querySelector('[role="dialog"]'), shell) }
  await clickSave(true)
  await clickSave(true)
  assert.equal(seen.length, 2)
  assert.ok(seen.every((request) => request.url === '/api/hrm/benefit-plan-configuration/benefit-plans'))
  assert.ok(isUuid(seen[0]!.headers['idempotency-key']!))
  assert.equal(seen[0]!.headers['idempotency-key'], seen[1]!.headers['idempotency-key'])
  assert.equal(alertText(), 'Choose a payroll component in this legal entity.')
  assert.equal(document.querySelector('[role="dialog"]'), shell)
  assert.equal((seen[0]!.body as Record<string, unknown>).kind, kind)
})
}

test('availability rows use named inputs and preserve zoned instants while editing in one drawer', async (t) => {
  const windows = [{ startsAt: '2026-10-01T09:00:00-04:00', endsAt: '2026-10-01T10:00:00-04:00', timezone: 'America/Toronto', source: 'declared' }]
  const ui = await mountDrawer(t, { id: 'pool', name: 'Interview panel', availability: windows, is_active: true }, () => Response.json({ id: 'pool' }), 'hrm-interviewer-pools')
  const shell = document.querySelector('[role="dialog"]')
  assert.equal(document.querySelectorAll('textarea').length, 0)
  await act(async () => setTextInput(FIELD_LABEL.endsAt!, '2026-10-01T11:00:00-04:00'))
  await clickSave(false)
  assert.equal(ui.seen.length, 1)
  assert.deepEqual((ui.seen[0]!.body as Record<string, unknown>).availability, [{ ...windows[0], endsAt: '2026-10-01T11:00:00-04:00' }])
  assert.equal(document.querySelector('[role="dialog"]'), shell)
  await act(async () => clickButton(adminCatalog.structuredFields!.addRow!).click())
  assert.equal(document.querySelectorAll('fieldset').length, 2)
  await clickSave(false)
  assert.equal(ui.seen.length, 1, 'an incomplete new window is refused before a write')
  assert.match(alertText() ?? '', /availability row 2: startsAt is required/)
})

test('clause controls retain underscore storage keys and explicitly toggle default inclusion', async (t) => {
  const clause = { key: 'notice', label: 'Notice', body: 'Two weeks', default_on: false }
  const ui = await mountDrawer(t, { id: 'template', name: 'Offer', body_template: 'Offer content', clauses: [clause] }, () => Response.json({ id: 'template' }), 'hrm-offer-templates')
  const fieldset = document.querySelector('fieldset')!
  assert.ok(fieldset)
  assert.equal(fieldset.querySelectorAll('textarea').length, 1, 'only the human clause text is a textarea')
  assert.equal((fieldset.querySelector('textarea') as HTMLTextAreaElement).value, clause.body)
  const checkbox = fieldset.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => checkbox.click())
  await clickSave(false)
  assert.deepEqual((ui.seen[0]!.body as Record<string, unknown>).clauses, [{ ...clause, default_on: true }])
})

test('retention scope shows native region choices and country chips without a JSON editor', async (t) => {
  const region = { applies_to: 'countries', countries: ['CA', 'US'] }
  const ui = await mountDrawer(t, { id: 'rule', name: 'Retention', region_scope: region, basis: 'inactivity', retain_months: 24, action: 'anonymize' }, () => Response.json({ id: 'rule' }), 'hrm-retention-rules')
  assert.equal(document.querySelectorAll('textarea').length, 0)
  assert.ok(document.body.textContent?.includes('CA'))
  assert.ok(document.body.textContent?.includes('US'))
  await clickSave(false)
  assert.deepEqual((ui.seen[0]!.body as Record<string, unknown>).regionScope, region)
})

for (const target of ['plan', 'component'] as const) {
  test(`${target} service tier saves only the financial controls for its target`, async (t) => {
    const initial = { afterMonths: '60', planId: target === 'plan' ? '11111111-1111-4111-8111-111111111111' : null,
      componentId: target === 'component' ? '22222222-2222-4222-8222-222222222222' : null,
      accrualValue: '0', annualDays: '20', eligible: false, effectiveFrom: '2026-01-01' }
    const { seen } = await mountDrawer(t, null, () => Response.json({ id: 'tier' }), 'entitlement-service-tiers', initial)
    assert.equal(Boolean(document.querySelector(`input[aria-label="${FIELD_LABEL.annualDays}"]`)), target === 'plan')
    await clickSave(true)
    assert.equal(seen.length, 1)
    const payload = seen[0]!.body as Record<string, unknown>
    assert.equal(payload.eligible, target === 'component' ? false : null)
    assert.equal(payload.annualDays, target === 'plan' ? '20' : null)
    assert.equal(payload.accrualValue, target === 'plan' ? '0' : null)
  })
}
