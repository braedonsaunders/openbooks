import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F1-7: deleting a dunning policy was fire-and-forget — the DELETE ran
// without a status check, so a refusal never surfaced and the row silently
// reappeared on the next load. Mounts the real CollectionsClient under
// jsdom, opens the dunning tab, and drives the delete refusal.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/collections',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const script = {
  deletes: [] as string[],
  loads: 0,
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
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__collectionsTestRouter}export function usePathname(){return "/collections"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
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
const messages = (await import('../../../messages/en')).default
const { CollectionsClient } = await import('./CollectionsClient')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const POLICY = {
  id: 'pol-1',
  name: 'Standard net-30',
  appliesToKind: 'customer_invoice',
  gracePeriodDays: 0,
  minBalance: '0',
  isActive: true,
  stages: [
    { sequence: 1, name: 'First reminder', offsetDays: 7, subjectTemplate: 's', bodyTemplate: 'b' },
  ],
}

async function mount(t: TestContext, deleteResponder: () => Response): Promise<void> {
  script.deletes = []
  script.loads = 0
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/recurring') return Response.json({ schedules: [] })
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
        <CollectionsClient />
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

async function openDunning(): Promise<void> {
  const tab = findButton('Dunning ladders')
  assert.ok(tab, 'the dunning tab must render')
  await click(tab)
}

test('a delete refusal names the reason inline and the row stays', async (t) => {
  await mount(t, () => Response.json({ error: 'policy is assigned to 3 customers' }, { status: 422 }))
  await openDunning()
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
  await openDunning()
  const del = findButton('Delete')
  assert.ok(del, 'the row must offer Delete')
  await click(del)
  assert.equal(document.querySelector('[role="alert"]'), null, 'no refusal renders on success')
  assert.equal(script.loads, 2, 'a confirmed delete reloads the list')
})
