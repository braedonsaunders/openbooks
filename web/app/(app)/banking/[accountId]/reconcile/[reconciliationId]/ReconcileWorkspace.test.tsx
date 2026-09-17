import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F-t05-018: sign-off blocked by unmatched lines 422s with zero user
// feedback. The route answers a typed { error } body, but the workspace's
// call() does `await res.json()` bare: when the error body is not JSON
// (empty body, proxy 5xx page) the READ itself throws, the toast never
// fires, and the failure goes silent with an unhandled rejection. The fix
// mirrors the documents row-action hardening: never let the read throw,
// always surface the server message or the fallback copy.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/banking/acc/reconcile/rec',
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
  toasts: [] as Array<{ kind: string; message: string }>,
}
Object.assign(globalThis, {
  __reconcileTestToasts: script.toasts,
  __reconcileTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__reconcileTestRouter}export function usePathname(){return "/banking/acc/reconcile/rec"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__reconcileTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__reconcileTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__reconcileTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
      }
    }
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){return true}',
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
const messages = (await import('../../../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../../../components/money-provider')
const { ReconcileWorkspace } = await import('./ReconcileWorkspace')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const pane = { q: '', sort: 'date', dir: 'asc' as const, page: 1, perPage: 25 }

async function mountWorkspace(t: TestContext, fetchImpl: typeof fetch): Promise<void> {
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
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ReconcileWorkspace
            basePath="/banking/acc/reconcile/rec"
            accountPath="/banking/acc"
            currentParams={{}}
            reconciliation={{ id: 'rec-1', status: 'in_progress', throughDate: '2026-09-10', statementBalance: '17070.01', currency: 'CAD' }}
            difference="0.00"
            canReconcile
            stmtRows={[]}
            stmtTotal={0}
            stmtParams={pane}
            glRows={[]}
            glTotal={0}
            glParams={pane}
            matchedRows={[]}
            matchedTotal={0}
            mParams={pane}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

function signOffButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Sign off'))
  assert.ok(found, 'the balanced workspace must offer Sign off')
  return found as HTMLButtonElement
}

test('a sign-off refusal surfaces the server message', async (t) => {
  await mountWorkspace(t, (async () => Response.json(
    { error: 'Cannot sign off: 3 statement line(s) through the cutoff remain unmatched' },
    { status: 422 },
  )) as typeof fetch)
  await act(async () => {
    signOffButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error' && toast.message.includes('3 statement line(s)')),
    `the refusal must surface, got ${JSON.stringify(script.toasts)}`,
  )
  assert.equal(signOffButton().disabled, false, 'the workspace must not wedge busy after a refusal')
})

test('an unreadable sign-off error body still surfaces the fallback copy', async (t) => {
  await mountWorkspace(t, (async () => new Response('', { status: 422 })) as typeof fetch)
  await act(async () => {
    signOffButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error'),
    `an empty-body 422 must still toast, got ${JSON.stringify(script.toasts)}`,
  )
  assert.equal(signOffButton().disabled, false, 'the workspace must not wedge busy on an unreadable body')
})
