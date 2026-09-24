import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F1-3/F1-4: the expense submit/post and delete actions used to parse the
// response body BEFORE checking the status with no try/catch, so a non-JSON
// 502 page threw a SyntaxError out of the handler (no toast at all, or a
// parse error instead of the server's refusal) and a thrown fetch left busy
// wedged. These tests mount the real ExpenseDrawer under jsdom and drive
// the failure paths with scripted fetches.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/expenses/reports',
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
  pushed: [] as string[],
}
Object.assign(globalThis, {
  __expenseErrorTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__expenseErrorTestRouter}export function usePathname(){return "/expenses/reports"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(m){(globalThis.__expenseErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}',
      }
    }
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){return true}',
      }
    }
    if (specifier.endsWith('/lib/prompt')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function promptDialog(){return null}',
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
const { MoneyProvider } = await import('../../../components/money-provider')
const { ExpenseDrawer } = await import('./ExpenseDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const REPORT_ID = '019f0000-0000-4000-8000-000000000003'
const UPDATED_AT = '2026-09-01T10:00:00.000000Z'

function makeDoc(): Record<string, unknown> {
  return {
    id: REPORT_ID,
    kind: 'expense_report',
    status: 'draft',
    party_id: 'employee-1',
    employee_name: 'Sammy Sloppy',
    document_number: 'EXP-00001',
    document_date: '2026-07-15',
    memo: '',
    subtotal: '875.50',
    tax_total: '0',
    total: '875.50',
    custom: {},
    extra_dims: {},
    updated_at: UPDATED_AT,
    submitted_by: 'submitter-1',
    created_by: 'submitter-1',
  }
}

async function mountDrawer(
  t: TestContext,
  actionsResponder: () => Response,
  deleteResponder: () => Response,
): Promise<{ host: HTMLElement; requests: { url: string; method: string; body?: unknown }[] }> {
  script.errors = []
  script.pushed = []
  const requests: { url: string; method: string; body?: unknown }[] = []
  ;(globalThis as Record<string, unknown>).__expenseErrorToasts = script.errors
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ url, method, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) })
    if (url.startsWith('/api/flows/manual')) return Response.json({ buttons: [] })
    if (url.startsWith('/api/flows/record-state')) {
      return Response.json({ approvalState: { status: 'draft', pendingWith: [], myActions: null }, history: [] })
    }
    if (url === `/api/expenses/${REPORT_ID}` && method === 'GET') {
      return Response.json({ doc: makeDoc(), lines: [] })
    }
    if (url === '/api/expenses/actions' && method === 'POST') return actionsResponder()
    if (url === `/api/expenses/${REPORT_ID}` && method === 'DELETE') return deleteResponder()
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
        <MoneyProvider currency="CAD">
          <ExpenseDrawer
            report={{ doc: makeDoc(), lines: [] } as never}
            initialMode="view"
            employees={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            departments={[]}
            projects={[]}
            segments={[]}
            headerDefs={[]}
            lineDefs={[]}
            canSubmit
            canPost={false}
            canRecall={false}
            closeHref="/expenses/reports"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
  return { host, requests }
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

/** Submit/Post/Delete live inside the Actions popover menu — open it first. */
async function openActions(): Promise<void> {
  const menu = findButton('Actions')
  assert.ok(menu, 'the Actions menu must render')
  await click(menu)
}

test('a non-JSON 502 on submit toasts the translated fallback with the status and releases the button', async (t) => {
  await mountDrawer(
    t,
    () => new Response('<html><body>Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    () => Response.json({ ok: true }),
  )
  await openActions()
  const submit = findButton('Submit for approval')
  assert.ok(submit, 'a draft must offer Submit for approval')
  await click(submit)
  assert.deepEqual(script.errors, ['Action failed (status 502)'])
  const again = findButton('Submit for approval')
  assert.ok(again && !again.disabled, 'busy must release after a transport failure so the operator can retry')
})

test('a named 422 refusal on submit surfaces the server message', async (t) => {
  await mountDrawer(
    t,
    () => Response.json({ error: 'period 2026-07 is closed for AP' }, { status: 422 }),
    () => Response.json({ ok: true }),
  )
  await openActions()
  const submit = findButton('Submit for approval')
  assert.ok(submit, 'a draft must offer Submit for approval')
  await click(submit)
  assert.deepEqual(script.errors, ['period 2026-07 is closed for AP'])
})

test('a named delete refusal toasts the reason, keeps the drawer open, and releases the button', async (t) => {
  const { requests } = await mountDrawer(
    t,
    () => Response.json({ ok: true }),
    () => Response.json({ error: 'report is locked by an active approval run' }, { status: 423 }),
  )
  await openActions()
  const del = findButton('Delete')
  assert.ok(del, 'a draft must offer Delete')
  await click(del)
  assert.deepEqual(
    requests.find((request) => request.url === `/api/expenses/${REPORT_ID}` && request.method === 'DELETE')?.body,
    { expectedUpdatedAt: UPDATED_AT },
    'delete must carry the exact loaded revision to the server fence',
  )
  assert.deepEqual(script.errors, ['report is locked by an active approval run'])
  assert.deepEqual(script.pushed, [], 'a refused delete must not navigate away')
  const again = findButton('Delete')
  assert.ok(again && !again.disabled, 'busy must release after a refused delete')
})
