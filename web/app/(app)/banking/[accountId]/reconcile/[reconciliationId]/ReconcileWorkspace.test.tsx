import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// sign-off blocked by unmatched lines 422s with zero user
// feedback. The route answers a typed { error } body, but the workspace's
// call does `await res.json` bare: when the error body is not JSON
// (empty body, proxy 5xx page) the READ itself throws, the toast never
// fires, and the failure goes silent with an unhandled rejection. The fix
// mirrors the documents row-action hardening: never let the read throw,
// always surface the server message or the fallback copy.
const { bootJsdomEnvironment } = await import('../../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/banking/acc/reconcile/rec', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

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
const { stubModules } = await import('../../../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__reconcileTestRouter}export function usePathname(){return "/banking/acc/reconcile/rec"}export function useSearchParams(){return new URLSearchParams()}' })
registerHooks({
  resolve(specifier, context, next) {

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

async function mountWorkspace(
  t: TestContext,
  fetchImpl: typeof fetch,
  override: {
    status?: string;
    stmtRows?: { id: string; posted_on: string; amount: string; description: string | null; counterparty_ref?: string | null }[];
    stmtTotal?: number;
    stmtOutstandingTotal?: string;
    glRows?: { id: string; posting_date: string; entry_number: string; amount: string; memo: string | null; party?: string | null }[];
    glTotal?: number;
    glOutstandingTotal?: string;
  } = {},
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
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ReconcileWorkspace
            basePath="/banking/acc/reconcile/rec"
            accountPath="/banking/acc"
            currentParams={{}}
            reconciliation={{ id: 'rec-1', status: override.status ?? 'in_progress', throughDate: '2026-09-10', statementBalance: '17070.01', currency: 'CAD' }}
            difference="0.00"
            canReconcile
            stmtRows={override.stmtRows ?? []}
            stmtTotal={override.stmtTotal ?? 0}
            stmtOutstandingTotal={override.stmtOutstandingTotal ?? '0'}
            stmtParams={pane}
            glRows={override.glRows ?? []}
            glTotal={override.glTotal ?? 0}
            glOutstandingTotal={override.glOutstandingTotal ?? '0'}
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

test('adjustment inputs are associated with their visible labels', async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch)
  const adjust = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Adjust'))
  assert.ok(adjust, 'the workspace offers an adjustment action')
  await act(async () => {
    adjust.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  for (const name of ['Reconcile through', 'Statement balance']) {
    const label = [...document.querySelectorAll('label')].find((candidate) => candidate.textContent?.includes(name))
    assert.ok(label, `${name} label renders`)
    assert.ok(label.control, `${name} label controls its input`)
  }
})

test('adjustment balance refuses exponent notation and posts large amounts as exact text', async (t) => {
  let requestBody: Record<string, unknown> | undefined
  await mountWorkspace(t, (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') requestBody = JSON.parse(String(init.body)) as Record<string, unknown>
    return Response.json({})
  }) as typeof fetch)
  const adjust = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Adjust'))
  assert.ok(adjust)
  await act(async () => {
    adjust.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  const balance = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null
  assert.ok(balance)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(balance, '1e3')
    balance.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  const save = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Save')) as HTMLButtonElement | undefined
  assert.ok(save && save.disabled, 'scientific notation must be refused client-side')
  await act(async () => {
    setter?.call(balance, '9007199254740993.0123')
    balance.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  assert.ok(save && !save.disabled)
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  assert.equal(requestBody?.statementBalance, '9007199254740993.0123')
})

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

test('grouped selection posts both sides as one group', async (t) => {
  const calls: { url: string; body?: string }[] = []
  await mountWorkspace(t, (async (_input: unknown, init?: RequestInit) => {
    if (String(_input).includes('/matches') && init?.method === 'POST') {
      calls.push({ url: String(_input), body: String(init.body) })
    }
    return Response.json({ ok: true, totals: { difference: '0.00' } })
  }) as typeof fetch, {
    stmtRows: [
      { id: 'stmt-a', posted_on: '2026-09-01', amount: '-4000.00', description: 'Wire A' },
      { id: 'stmt-b', posted_on: '2026-09-01', amount: '-4000.00', description: 'Wire B' },
    ],
    stmtTotal: 2,
    stmtOutstandingTotal: '-8000.00',
    glRows: [{ id: 'gl-1', posting_date: '2026-08-30', entry_number: 'JE-9', amount: '-8000.00', memo: null, party: null }],
    glTotal: 1,
    glOutstandingTotal: '-8000.00',
  })
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
  assert.equal(boxes.length, 3, 'both bank lines and the ledger line offer checkboxes')
  await act(async () => {
    for (const box of boxes) box.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 6; i++) await tick()
  })
  const match = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Match selected') as HTMLButtonElement | undefined
  assert.ok(match, 'the workspace offers Match selected')
  assert.equal(match.disabled, false, 'a selected group enables Match selected')
  await act(async () => {
    match.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 6; i++) await tick()
  })
  const posted = calls.find((c) => c.url.includes('/matches'))
  assert.ok(posted, 'matching must POST the session matches route')
  const body = JSON.parse(posted.body ?? '{}') as { statementLineIds?: string[]; journalLineIds?: string[] }
  assert.deepEqual([...(body.statementLineIds ?? [])].sort(), ['stmt-a', 'stmt-b'], 'both bank lines post as the group')
  assert.deepEqual(body.journalLineIds, ['gl-1'], 'the ledger side posts with them')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success'),
    `the group match must toast success, got ${JSON.stringify(script.toasts)}`,
  )
})

test('a signed-off session lists its outstanding items with totals instead of empty panes', async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch, {
    status: 'signed_off',
    stmtRows: [],
    stmtTotal: 0,
    stmtOutstandingTotal: '0',
    glRows: [{ id: 'gl-orphan', posting_date: '2026-09-05', entry_number: 'JE-7', amount: '250.00', memo: 'Deposit in transit', party: null }],
    glTotal: 1,
    glOutstandingTotal: '250.00',
  })
  const text = document.body.textContent ?? ''
  assert.ok(text.includes('Deposit in transit'), 'the orphaned book entry stays visible after sign-off')
  assert.ok(text.includes('outstanding'), 'the panes name their outstanding totals')
  assert.ok(!text.includes('Match selected'), 'a signed-off session offers no matching')
  assert.ok(!text.includes('Sign off'), 'a signed-off session offers no second sign-off')
})
