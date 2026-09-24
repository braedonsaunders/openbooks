import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// A-S03: running rules parsed the response body BEFORE checking the status,
// so a non-JSON 502 page threw a SyntaxError out of the handler — no refusal
// toast — and the Run button wedged on "Running…". Mounts the real
// RunRulesButton under jsdom and drives the failure paths with scripted
// fetches.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/banking/rules',
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
  errors: [] as string[],
}
Object.assign(globalThis, {
  __rulesTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__rulesTestRouter}export function usePathname(){return "/banking/rules"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},info(){},message(){},error(m){(globalThis.__rulesErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}',
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
const { RunRulesButton } = await import('./RuleDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const ACCOUNTS = [{ id: 'acc-1', label: 'Operating' }]

async function mount(t: TestContext, responder: () => Response): Promise<void> {
  script.errors = []
  ;(globalThis as Record<string, unknown>).__rulesErrorToasts = script.errors
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && String(input).includes('/api/banking/rules/apply')) {
      return responder()
    }
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
        <RunRulesButton accounts={ACCOUNTS} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
}

/** The dialog carries its own Run button after the outer opener. */
function findDialogButton(text: string): HTMLButtonElement | undefined {
  const matches = [...document.querySelectorAll('button')].filter(
    (b) => (b.textContent ?? '').trim() === text,
  )
  return matches[matches.length - 1] as HTMLButtonElement | undefined
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
}

/** Open the run dialog; the dialog's Run button carries the same label. */
async function openDialog(): Promise<void> {
  const open = findButton('Run rules')
  assert.ok(open, 'the run button must render')
  await click(open)
  await act(async () => {
    await tick()
    await tick()
  })
}

test('a non-JSON 502 toasts the named failure and releases Run', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
  await openDialog()
  const run = findDialogButton('Run rules')
  assert.ok(run && !run.disabled, 'Run must enable once an account is selected')
  await click(run)
  assert.deepEqual(script.errors, ['Could not run rules (status 502)'])
  const again = findDialogButton('Run rules')
  assert.ok(again && !again.disabled, 'busy must release after a transport failure')
})

test('a named 422 refusal surfaces the server message', async (t) => {
  await mount(t, () => Response.json({ error: 'rules are disabled for this account' }, { status: 422 }))
  await openDialog()
  const run = findDialogButton('Run rules')
  assert.ok(run, 'Run must render')
  await click(run)
  assert.deepEqual(script.errors, ['rules are disabled for this account'])
})

test('a clean dry run toasts the match summary', async (t) => {
  await mount(t, () => Response.json({ matched: 2, excluded: 1, suggested: 0, scanned: 9 }))
  await openDialog()
  const run = findDialogButton('Run rules')
  assert.ok(run, 'Run must render')
  await click(run)
  assert.deepEqual(script.errors, [], 'a successful run toasts nothing as an error')
})
