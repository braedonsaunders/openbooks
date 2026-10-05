import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// Domain refusals remain visible and retain their records in the shared list.
const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/collections', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const script = {
  deletes: [] as string[],
  writes: [] as Record<string, unknown>[],
  loads: 0,
  recurringLoads: 0,
  recurringFailFirst: false,
}
Object.assign(globalThis, {
  __collectionsTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__collectionsTestRouter}export function usePathname(){return "/collections"}export function useSearchParams(){return new URLSearchParams(globalThis.__collectionsTestQuery ?? "")}' })
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
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
const messages = (await import('../../../messages/en')).default
const { CollectionsClient } = await import('./CollectionsClient')
const { MoneyProvider } = await import('../../../components/money-provider')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const POLICY = {
  id: 'pol-1',
  name: 'Standard net-30',
  appliesToKind: 'customer_invoice',
  gracePeriodDays: 0,
  minBalance: '0',
  isActive: true,
  updatedAt: "2026-10-01T10:00:00.000001Z",
  stages: [
    { id: 'stage-1', sequence: 4, name: 'First reminder', offsetDays: 7, subjectTemplate: 's', bodyTemplate: 'b' },
  ],
}

async function mount(t: TestContext, deleteResponder: () => Response, recurringFailFirst = false, view: 'policies' | 'recurring' | 'plans' = 'policies', policyParam = ''): Promise<void> {
  Object.assign(globalThis, { __collectionsTestQuery: policyParam ? `policy=${policyParam}` : "" })
  script.writes = []
  script.deletes = []
  script.loads = 0
  script.recurringLoads = 0
  script.recurringFailFirst = recurringFailFirst
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'POST' || method === 'PATCH') { script.writes.push(JSON.parse(String(init?.body))); return deleteResponder() }
    if (url === '/api/subscriptions') return Response.json({ plans: [], subscriptions: [], mrr: '0' })
    if (url === '/api/recurring') return ++script.recurringLoads === 1 && script.recurringFailFirst ? Response.json({}, { status: 503 }) : Response.json({ schedules: [] })
    if (url === '/api/dunning' && method === 'GET') {
      script.loads += 1
      return Response.json({ policies: [POLICY] })
    }
    if (url === '/api/dunning/pol-1' && method === 'DELETE') {
      script.deletes.push(url)
      return deleteResponder()
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD"><CollectionsClient initialView={view} subscriptionsEnabled /></MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
}


test('a delete refusal names the reason inline and the row stays', async (t) => {
  await mount(t, () => Response.json({ error: 'policy is assigned to 3 customers' }, { status: 422 }))
  assert.ok(document.body.textContent?.includes('Standard net-30'), 'the policy row must render')
  const del = findButton('Delete')
  assert.ok(del, 'the row must offer Delete')
  await click(del)
  assert.deepEqual(script.deletes, ['/api/dunning/pol-1'])
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the refusal must render inline')
  assert.match(alert.textContent ?? '', /policy is assigned to 3 customers/)
  assert.ok(document.body.textContent?.includes('Standard net-30'), 'the refused row must stay')
  assert.equal(script.loads, 1, 'a refused delete must not reload over the row')
})

test('a successful delete reloads the list', async (t) => {
  await mount(t, () => Response.json({ ok: true }))
  const del = findButton('Delete')
  assert.ok(del, 'the row must offer Delete')
  await click(del)
  assert.equal(document.querySelector('[role="alert"]'), null, 'no refusal renders on success')
  assert.equal(script.loads, 2, 'a confirmed delete reloads the list')
})

test('a failed recurring-schedule read shows retry instead of none yet', async (t) => {
  await mount(t, () => Response.json({ ok: true }), true, 'recurring')
  assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes('Failed to load'))
  assert.ok(!document.body.textContent?.includes('No recurring schedules yet.'))
  await click(findButton('Retry')!)
  assert.ok(script.recurringLoads === 2 && document.body.textContent?.includes('No recurring schedules yet.'))
})

async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
}

test('a plan save refusal retains its exact decimal draft and names the remedy', async (t) => {
  await mount(t, () => Response.json({ error: 'The income account is inactive. Choose an active account.' }, { status: 409 }), false, 'plans')
  await click(findButton('New plan')!)
  const dialog = document.querySelector('[role="dialog"]')!
  const name = dialog.querySelector('input[aria-labelledby]') as HTMLInputElement
  const price = dialog.querySelector('input[inputmode="decimal"]') as HTMLInputElement
  await fill(name, 'Annual support'); await fill(price, '1234.5600'); await click(findButton('Add plan')!)
  assert.equal(script.writes.length, 1)
  assert.ok(script.writes[0]); assert.equal(script.writes[0].name, 'Annual support'); assert.equal(script.writes[0].amount, '1234.5600')
  assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? '', /Choose an active account/)
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.equal(name.value, 'Annual support'); assert.equal(price.value, '1234.5600')
})

test('editing reminders preserves their identities and numbers additions after the stored sequence', async (t) => {
  await mount(t, () => Response.json({ error: 'Policy changed. Reload before saving.' }, { status: 409 }), false, 'policies', 'pol-1')
  // The record opens read-only; reminders edit after entering edit mode.
  await click(findButton('Edit')!)
  const dialog = document.querySelector('[role="dialog"]')!
  await click(findButton('Add reminder')!)
  assert.deepEqual([...dialog.querySelectorAll('input[aria-label="Sequence"]')].map((input) => (input as HTMLInputElement).value), ['4', '5'])
  await click([...dialog.querySelectorAll('button')].filter((button) => button.textContent?.includes('Remove row')).at(-1)!)
  await fill(dialog.querySelector('textarea') as HTMLTextAreaElement, 'Please contact Accounts Receivable.')
  await click(findButton('Save')!)
  assert.equal(script.writes.length, 1); assert.ok(script.writes[0]); assert.equal(script.writes[0].expectedUpdatedAt, POLICY.updatedAt)
  const stages = script.writes[0].stages as typeof POLICY.stages
  assert.ok(stages[0]); assert.equal(stages[0].id, 'stage-1'); assert.equal(stages[0].sequence, 4)
  assert.equal(stages[0].bodyTemplate, 'Please contact Accounts Receivable.')
})
