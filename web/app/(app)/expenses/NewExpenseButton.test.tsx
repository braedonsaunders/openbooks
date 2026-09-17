import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F-t04-015: "New expense report" flips to "Creating…" and stays there
// forever when the draft create throws — NewExpenseButton has no
// try/catch/finally, so a thrown fetch/json leaves busy=true with zero
// feedback. A failed create must reset the button and surface the error.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/expenses',
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

const script = {
  toasts: [] as Array<{ kind: 'success' | 'error'; message: string }>,
  pushed: [] as string[],
}
Object.assign(globalThis, {
  __newExpenseButtonTestToasts: script.toasts,
  __newExpenseButtonTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__newExpenseButtonTestRouter}export function usePathname(){return "/expenses"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(message){globalThis.__newExpenseButtonTestToasts.push({kind:"success",message})},error(message){globalThis.__newExpenseButtonTestToasts.push({kind:"error",message})}};export function Toaster(){return null}',
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
const { NewExpenseButton } = await import('./NewExpenseButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountButton(
  t: TestContext,
  fetchImpl: typeof fetch,
): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = fetchImpl
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
  script.toasts.length = 0
  script.pushed.length = 0
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <NewExpenseButton />
      </NextIntlClientProvider>,
    )
    await tick()
  })
}

function button(): HTMLButtonElement {
  const found = document.querySelector('button')
  assert.ok(found, 'the New expense report button must render')
  return found as HTMLButtonElement
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
}

test('a thrown create resets the button and surfaces the error', async (t) => {
  await mountButton(t, (async () => {
    throw new Error('connection reset')
  }) as typeof fetch)
  await click(button())
  assert.equal(button().disabled, false, 'the button must leave the busy state after a thrown create')
  assert.ok(
    (button().textContent ?? '').includes('New expense report'),
    'the label must flip back from Creating…',
  )
  assert.equal(script.toasts.length, 1, 'the failure must surface exactly one error')
  assert.equal(script.toasts[0]!.kind, 'error')
  assert.equal(script.pushed.length, 0, 'a failed create must not navigate')
})

test('a refused create resets the button and surfaces the server error', async (t) => {
  await mountButton(t, (async () => Response.json({ error: 'expenses are closed' }, { status: 422 })) as typeof fetch)
  await click(button())
  assert.equal(button().disabled, false, 'the button must leave the busy state after a refused create')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error' && toast.message.includes('expenses are closed')),
    'the server error must surface',
  )
  assert.equal(script.pushed.length, 0, 'a refused create must not navigate')
})

test('a created draft still opens the editor', async (t) => {
  const id = '019f0000-0000-4000-8000-000000000004'
  await mountButton(t, (async () => Response.json({ id })) as typeof fetch)
  await click(button())
  assert.deepEqual(script.pushed, [`/expenses/reports?expense=${id}&mode=edit`])
  assert.equal(script.toasts.length, 0, 'a clean create toasts nothing')
})
