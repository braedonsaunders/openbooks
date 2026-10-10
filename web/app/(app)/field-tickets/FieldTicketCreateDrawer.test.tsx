import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// New ticket is an unsaved create: opening the drawer writes nothing, Save
// POSTs the collection once with a per-session Idempotency-Key (a retried
// Save replays the same key), and the persisted ticket's editor opens in
// place of the create URL. A refusal stays in the drawer by name.
const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/field-tickets?ticketNew=1', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const router = { pushes: [] as string[], replaces: [] as string[], refreshes: 0 }
Object.assign(globalThis, {
  __ftCreateRouter: {
    push(url: string) { router.pushes.push(String(url)) },
    replace(url: string) { router.replaces.push(String(url)) },
    refresh() { router.refreshes += 1 },
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__ftCreateRouter}export function usePathname(){return "/field-tickets"}export function useSearchParams(){return new URLSearchParams("ticketNew=1")}' })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}' }
    }
    if (specifier === '@/lib/confirm') {
      return { shortCircuit: true, url: 'data:text/javascript,export function confirmDialog(){return Promise.resolve(true)};export function ConfirmRoot(){return null}' }
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
const { FieldTicketCreateDrawer } = await import('./FieldTicketCreateDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const en = (messages as { fieldTickets: { list: Record<string, string> } }).fieldTickets.list

type Sent = { url: string; method: string; key: string | null; body: unknown }

async function mount(t: TestContext, respond: () => Response): Promise<Sent[]> {
  const sent: Sent[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    sent.push({ url: String(input), method: init?.method ?? 'GET', key: headers.get('Idempotency-Key'), body: init?.body ? JSON.parse(String(init.body)) : null })
    return respond()
  }) as typeof fetch
  router.pushes.length = 0
  router.replaces.length = 0
  router.refreshes = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    globalThis.fetch = prior
    await act(async () => root.unmount())
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <FieldTicketCreateDrawer
          createMode
          today="2026-10-05"
          projects={[{ id: '00000000-0000-4000-8000-0000000000a1', name: 'P-1 · Tower', customerName: 'Acme', period: 'daily' }]}
        />
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 6; i++) await tick()
  })
  return sent
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  assert.ok(found, `button "${label}" renders`)
  return found as HTMLButtonElement
}

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 6; i++) await tick()
  })
}

async function pickProject() {
  const trigger = [...document.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').includes(en.pickProject))
  assert.ok(trigger, 'the project picker renders')
  await click(trigger)
  const option = [...document.querySelectorAll('button[role="option"]')].find((candidate) => (candidate.textContent ?? '').includes('Tower'))
  assert.ok(option, 'the picker offers the in-scope project')
  await click(option)
}

test('opening New ticket writes nothing and Save without a project refuses in place', async (t) => {
  const sent = await mount(t, () => Response.json({ id: 'unexpected' }, { status: 201 }))
  assert.deepEqual(sent, [], 'opening the drawer sends no request')
  await click(button('Save'))
  assert.deepEqual(sent, [], 'an incomplete create sends nothing')
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', new RegExp(en.projectRequired))
})

test('Save creates the ticket once under its session key and opens its editor', async (t) => {
  const id = '00000000-0000-4000-8000-0000000000f1'
  let fail = true
  const sent = await mount(t, () => fail
    ? Response.json({ error: 'Field Ticket policy has no period for this project' }, { status: 422 })
    : Response.json({ id, documentNumber: 'FT-00001' }, { status: 201 }))
  await pickProject()
  const period = document.querySelector('select') as HTMLSelectElement
  assert.equal(period.value, 'daily', 'the project policy proposes its period')

  await click(button('Save'))
  assert.equal(sent.length, 1)
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /no period for this project/)
  assert.deepEqual(router.replaces, [], 'a refused create stays in the drawer')

  fail = false
  await click(button('Save'))
  assert.equal(sent.length, 2)
  for (const request of sent) {
    assert.equal(request.url, '/api/field-tickets')
    assert.equal(request.method, 'POST')
    assert.deepEqual(request.body, { projectId: '00000000-0000-4000-8000-0000000000a1', date: '2026-10-05', period: 'daily' })
  }
  assert.ok(sent[0]!.key, 'Save carries an Idempotency-Key')
  assert.equal(sent[1]!.key, sent[0]!.key, 'a retried Save replays the same key')
  assert.deepEqual(router.replaces, [`/field-tickets?ticket=${id}&mode=edit`])
})

test('Cancel leaves without writing', async (t) => {
  const sent = await mount(t, () => Response.json({ id: 'unexpected' }, { status: 201 }))
  await pickProject()
  await click(button('Cancel'))
  assert.deepEqual(sent, [])
  assert.deepEqual(router.pushes, ['/field-tickets'])
})
