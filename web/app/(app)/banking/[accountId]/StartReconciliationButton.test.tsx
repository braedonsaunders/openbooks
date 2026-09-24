import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F1-5: starting a reconciliation parsed the response body BEFORE checking
// the status with no try/catch, so a non-JSON 502 page threw a SyntaxError
// out of the handler (no toast) and any thrown fetch left the Start button
// wedged on "Starting…". Mounts the real button under jsdom and drives the
// failure paths with scripted fetches.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/banking/acc-1',
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

const script = {
  errors: [] as string[],
  pushed: [] as string[],
}
Object.assign(globalThis, {
  __reconTestRouter: {
    push(url: string) { script.pushed.push(url) },
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__reconTestRouter}export function usePathname(){return "/banking/acc-1"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(m){(globalThis.__reconErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}',
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
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { StartReconciliationButton } = await import('./StartReconciliationButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(t: TestContext, responder: () => Response): Promise<void> {
  script.errors = []
  script.pushed = []
  ;(globalThis as Record<string, unknown>).__reconErrorToasts = script.errors
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') return responder()
    throw new Error(`unexpected fetch ${String(input)}`)
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
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-01">
            <StartReconciliationButton accountId="acc-1" openReconciliationId={null} glBalance="1200.00" />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
}

/** Open the drawer and enter a statement balance so Start enables. */
async function openAndFill(): Promise<void> {
  const open = findButton('Start reconciliation')
  assert.ok(open, 'the start button must render')
  await click(open)
  const balance = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null
  assert.ok(balance, 'the drawer must ask for the statement balance')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(balance, '1250.00')
    balance.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
    await tick()
  })
}

test('a non-JSON 502 toasts the translated fallback with the status and releases Start', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
  await openAndFill()
  const start = findButton('Start')
  assert.ok(start && !start.disabled, 'Start must enable once the balance is entered')
  await click(start)
  assert.deepEqual(script.errors, ['Could not start the reconciliation (status 502)'])
  assert.deepEqual(script.pushed, [], 'a failed start must not navigate')
  const again = findButton('Start')
  assert.ok(again && !again.disabled, 'busy must release after a transport failure')
})

test('a named 422 refusal surfaces the server message', async (t) => {
  await mount(t, () => Response.json({ error: 'an open session already exists for this account' }, { status: 422 }))
  await openAndFill()
  const start = findButton('Start')
  assert.ok(start, 'Start must render')
  await click(start)
  assert.deepEqual(script.errors, ['an open session already exists for this account'])
})

test('a successful start navigates to the new session', async (t) => {
  await mount(t, () => Response.json({ id: 'rec-9' }))
  await openAndFill()
  const start = findButton('Start')
  assert.ok(start, 'Start must render')
  await click(start)
  assert.deepEqual(script.pushed, ['/banking/acc-1/reconcile/rec-9'])
})
