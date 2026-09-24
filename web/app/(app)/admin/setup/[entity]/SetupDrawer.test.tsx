import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __setupDrawerRouter: { push(url: string): void; replace(url: string): void; refresh(): void } | undefined
  var __setupDrawerToasts: { kind: string; message: string }[] | undefined
}

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/account-groups?row=new',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement',
  'HTMLInputElement', 'HTMLButtonElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'self',
]) {
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
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function useRouter(){return globalThis.__setupDrawerRouter}export function usePathname(){return '/admin/setup/account-groups'}export function useSearchParams(){return new URLSearchParams(globalThis.__setupDrawerQuery ?? '')}`,
      }
    }
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

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
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
  row: Record<string, unknown> | null,
  responder: (seen: SeenRequest[]) => Response | Promise<Response>,
  entityKey: string = ENTITY_KEY,
  initialValues?: Record<string, unknown>,
) {
  const entity = SETUP_ENTITY_BY_KEY.get(entityKey)
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
        <SetupDrawer entity={entity} row={row} members={[]} refOptions={{}} initialValues={initialValues} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  return {
    pushes,
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

test('required setup fields are visibly marked, and only those validate() enforces', async () => {
  const { unmount } = await mountDrawer(null, () => Response.json({ ok: true }))
  try {
    const labels = [...document.querySelectorAll('label')].map((el) => el.textContent ?? '')
    for (const key of ['key', 'name', 'dimension']) {
      const label = labels.find((text) => text.startsWith(FIELD_LABEL[key]!))
      assert.ok(label, `expected a label for ${key}`)
      assert.ok(label!.endsWith('*'), `${key} is required so its label must carry the mark`)
    }
    // keepDefault blanks are legal input and booleans are never required:
    // neither may wear the mark or the mark lies about what blocks saving.
    for (const key of ['sortOrder', 'isActive']) {
      const label = labels.find((text) => text.startsWith(FIELD_LABEL[key]!))
      assert.ok(label, `expected a label for ${key}`)
      assert.ok(!label!.endsWith('*'), `${key} never blocks saving so it must not wear the mark`)
    }
  } finally {
    await unmount()
  }
})

test('a blank required save keeps an inline alert naming the field, with no write', async () => {
  const { seen, unmount } = await mountDrawer(null, () => Response.json({ ok: true }))
  try {
    await clickSave(true)
    assert.deepEqual(seen, [], 'a blocked save must not reach the API')
    assert.equal(alertText(), requiredCopy(FIELD_LABEL.key!), 'the alert names the first missing field')
  } finally {
    await unmount()
  }
})

test('blank keepDefault fields never block saving', async () => {
  // account-groups.sortOrder is keepDefault but NOT required, so it cannot
  // prove the branch: subsidiary-ownership-interests declares required AND
  // keepDefault together (method, acquisitionCost, acquisitionRate, …) with
  // the server applying its DB default to blanks. Every one of those stays
  // blank here; the save must still POST.
  const { seen, pushes, unmount } = await mountDrawer(
    null,
    () => Response.json({ ok: true, id: 'own-1' }),
    'subsidiary-ownership-interests',
    {
      parentSubsidiaryId: 'sub-parent',
      subsidiaryId: 'sub-child',
      effectiveFrom: '2026-01-01',
      ownershipPercent: '80',
      acquisitionDate: '2026-01-02',
      investmentAccountId: 'acc-invest',
      equityIncomeAccountId: 'acc-equity',
    },
  )
  try {
    await clickSave(true)
    assert.equal(seen.length, 1, 'blank keepDefault fields must not block the create')
    assert.equal(seen[0]!.method, 'POST')
    assert.deepEqual(pushes.length, 1, 'a successful create navigates home')
  } finally {
    await unmount()
  }
})

test('a failed transport releases the button with an inline error', async () => {
  const { unmount } = await mountDrawer(null, () => {
    throw new Error('down')
  })
  try {
    await fillValidCreate()
    await clickSave(true)
    assert.equal(alertText(), String(commonCatalog.feedback?.saveFailed), 'the transport failure names itself inline')
    assert.equal(
      clickButton(String(commonCatalog.actions?.create)).disabled,
      false,
      'the Create button must release after a transport failure',
    )
  } finally {
    await unmount()
  }
})

test('typed server conflicts resolve through their code, never the raw message', async () => {
  const { unmount } = await mountDrawer(null, () =>
    Response.json({ error: 'a server-worded human message', code: 'duplicate' }, { status: 409 }),
  )
  try {
    await fillValidCreate()
    await clickSave(true)
    assert.equal(alertText(), String(adminCatalog.errors?.duplicate), 'a duplicate maps to localized copy')
  } finally {
    await unmount()
  }
})

test('typed validation failures render their message verbatim', async () => {
  const refusal = 'Code must be lowercase with no spaces'
  const { unmount } = await mountDrawer(null, () =>
    Response.json({ error: refusal, code: 'invalid' }, { status: 400 }),
  )
  try {
    await fillValidCreate()
    await clickSave(true)
    assert.equal(alertText(), refusal, 'an invalid refusal names its fix verbatim')
  } finally {
    await unmount()
  }
})

test('server required-field refusals render through the field label', async () => {
  const { unmount } = await mountDrawer(null, () =>
    Response.json({ error: 'name is required', code: 'invalid' }, { status: 400 }),
  )
  try {
    await fillValidCreate()
    await clickSave(true)
    assert.equal(
      alertText(),
      requiredCopy(FIELD_LABEL.name!),
      'the server refusal renders exactly like client-side validate()',
    )
  } finally {
    await unmount()
  }
})

test('exclusion-conflict 409s resolve through the overlap code, never raw Postgres', async () => {
  const { unmount } = await mountDrawer(null, () =>
    Response.json({ error: 'conflicting key value violates exclusion constraint', code: 'overlap' }, { status: 409 }),
  )
  try {
    await fillValidCreate()
    await clickSave(true)
    assert.equal(alertText(), String(adminCatalog.errors?.overlap), 'an overlap maps to localized copy')
  } finally {
    await unmount()
  }
})

test('creates mint one idempotency key per mounted session and reuse it across retries', async () => {
  let attempt = 0
  const { seen, unmount } = await mountDrawer(null, () => {
    attempt += 1
    if (attempt === 1) throw new Error('ambiguous failure')
    return Response.json({ ok: true, id: 'ag-1' })
  })
  try {
    await fillValidCreate()
    await clickSave(true)
    assert.equal(clickButton(String(commonCatalog.actions?.create)).disabled, false, 'the retry must be clickable')
    await clickSave(true)
    const posts = seen.filter((request) => request.method === 'POST')
    assert.equal(posts.length, 2, 'the retry replays the create')
    const first = posts[0]!.headers['idempotency-key'] ?? ''
    assert.ok(/^[0-9a-f-]{36}$/i.test(first), 'the create carries a UUID idempotency key')
    assert.equal(posts[1]!.headers['idempotency-key'], first, 'the retry reuses the session key, never a fresh one')
  } finally {
    await unmount()
  }
})

test('the idempotency key travels only on create POSTs, never on PATCH', async () => {
  const row = {
    id: 'ag-1',
    key: 'grp-1',
    name: 'Group One',
    dimension: 'department',
    color: '',
    sortOrder: 1,
    isActive: true,
  }
  const { seen, unmount } = await mountDrawer(row, () => Response.json({ ok: true }))
  try {
    await clickSave(false)
    assert.equal(seen.length, 1, 'the edit must save once')
    assert.equal(seen[0]!.method, 'PATCH')
    assert.ok(!('idempotency-key' in seen[0]!.headers), 'an edit must never replay as a create')
  } finally {
    await unmount()
  }
})
