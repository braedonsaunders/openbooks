import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F-user-003: expense reports need an Edit action with bill parity — drafts
// edit in place; pending_approval and approved-unposted Edit recalls to
// draft behind a visible confirm; posted Edits correct via the dedicated
// endpoint. These tests mount the real ExpenseDrawer under jsdom and drive
// the full client flows with scripted fetches.
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
  confirmCalls: 0,
  promptResult: null as string | null,
  pushed: [] as string[],
}
Object.assign(globalThis, {
  __expenseDrawerTestConfirmCalls: script,
  __expenseDrawerTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__expenseDrawerTestRouter}export function usePathname(){return "/expenses/reports"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}',
      }
    }
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){globalThis.__expenseDrawerTestConfirmCalls.confirmCalls++;return true}',
      }
    }
    if (specifier.endsWith('/lib/prompt')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function promptDialog(){return globalThis.__expenseDrawerTestPrompt}',
      }
    }
    if (specifier.endsWith('/lib/void-reversal-period')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function promptVoidReversalPeriod(){return {cancelled:false,reversalPeriodId:"period-1"}}',
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
const REPORT_ID = '019f0000-0000-4000-8000-000000000002'
const UPDATED_AT = '2026-09-01T10:00:00.000000Z'

function makeDoc(status: string): Record<string, unknown> {
  return {
    id: REPORT_ID,
    kind: 'expense_report',
    status,
    party_id: '',
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

interface ScriptedFetch {
  /** Canonical GET payload (doc + lines). */
  canonicalDoc: Record<string, unknown>
  recallResponse?: unknown
  correctResponse?: unknown
}

async function mountDrawer(
  t: TestContext,
  args: {
    status: string
    canSubmit: boolean
    canPost: boolean
    canRecall: boolean
    scripted: ScriptedFetch
    promptResult?: string | null
  },
): Promise<{ host: HTMLElement; requests: { url: string; method: string; body?: unknown }[] }> {
  const requests: { url: string; method: string; body?: unknown }[] = []
  script.confirmCalls = 0
  script.pushed = []
  ;(globalThis as Record<string, unknown>).__expenseDrawerTestPrompt = args.promptResult ?? null
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.startsWith('/api/flows/manual')) return Response.json({ buttons: [] })
    if (url.startsWith('/api/flows/record-state')) {
      return Response.json({ approvalState: { status: 'approved', pendingWith: [], myActions: null }, history: [] })
    }
    if (url === `/api/expenses/${REPORT_ID}` && method === 'GET') {
      return Response.json({ doc: args.scripted.canonicalDoc, lines: [] })
    }
    if (url === `/api/expenses/${REPORT_ID}` && method === 'PATCH') {
      return Response.json({ ok: true, doc: { id: REPORT_ID, updated_at: '2026-09-02T10:00:00.000000Z' }, lines: [], revision: '2026-09-02T10:00:00.000000Z' })
    }
    if (url === '/api/expenses/actions' && method === 'POST') {
      return Response.json(args.scripted.recallResponse ?? { ok: true, cancelledGates: 1, cancelledRuns: 1 })
    }
    if (url === `/api/expenses/${REPORT_ID}/correct` && method === 'POST') {
      return Response.json(args.scripted.correctResponse ?? { ok: true, correctionId: 'new-draft-id', correctionNumber: 'EXP-00002', voidStatus: 'voided', requestId: null })
    }
    if (url === `/api/documents/${REPORT_ID}/void` && method === 'POST') {
      return Response.json({ status: 'voided' })
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
    // Drawer shell + popover menus portal to document.body outside the
    // React root; drop every leftover so the next test starts isolated.
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ExpenseDrawer
            report={{ doc: makeDoc(args.status), lines: [] } as never}
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
            canSubmit={args.canSubmit}
            canPost={args.canPost}
            canRecall={args.canRecall}
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
  // The drawer shell and its popover menus portal to document.body, so
  // host-scoped queries miss every drawer control. Between tests the body
  // is nuked (see mountDrawer), so document-wide queries stay isolated.
  return [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
}

/** Save/Submit/Post live inside the Actions popover menu — open it first. */
async function openActions(): Promise<void> {
  const menu = findButton('Actions')
  assert.ok(menu, 'the Actions menu must render')
  await click(menu)
}

test('a submitted report Edits via recall: confirm, cancel gates, then the editor', async (t) => {
  const draftDoc = { ...makeDoc('pending_approval'), status: 'draft' }
  const { requests } = await mountDrawer(t, {
    status: 'pending_approval',
    canSubmit: true,
    canPost: false,
    canRecall: true,
    scripted: { canonicalDoc: draftDoc },
  })
  const edit = findButton('Edit')
  assert.ok(edit, 'a pending report must offer Edit with bill parity')
  await click(edit)
  assert.equal(script.confirmCalls, 1, 'editing a submitted report must confirm the approval reset first')
  const recall = requests.find((r) => r.url === '/api/expenses/actions' && r.method === 'POST')
  assert.deepEqual(
    recall?.body,
    { action: 'recall', documentId: REPORT_ID, expectedUpdatedAt: UPDATED_AT },
    'Edit must recall the report (revision-fenced) before editing',
  )
  await openActions()
  assert.ok(findButton('Save'), 'after the recall the drawer must route to the editor with the draft loaded')
})

test('a submitted report without recall rights offers no Edit', async (t) => {
  await mountDrawer(t, {
    status: 'pending_approval',
    canSubmit: true,
    canPost: false,
    canRecall: false,
    scripted: { canonicalDoc: makeDoc('pending_approval') },
  })
  assert.equal(findButton('Edit'), undefined, 'a stranger must not see Edit on a submitted report')
  assert.equal(script.confirmCalls, 0)
})

test('a draft Edits in place with no recall confirm', async (t) => {
  const { requests } = await mountDrawer(t, {
    status: 'draft',
    canSubmit: true,
    canPost: false,
    canRecall: false,
    scripted: { canonicalDoc: makeDoc('draft') },
  })
  const edit = findButton('Edit')
  assert.ok(edit, 'a draft must offer Edit')
  await click(edit)
  assert.equal(script.confirmCalls, 0, 'draft edits must not confirm')
  assert.ok(
    !requests.some((r) => r.url === '/api/expenses/actions'),
    'draft edits must not touch the actions route',
  )
  await openActions()
  const save = findButton('Save')
  assert.ok(save, 'a draft Edits in place')
  await click(save)
  const patch = requests.find((r) => r.url === `/api/expenses/${REPORT_ID}` && r.method === 'PATCH')
  assert.ok(patch, 'draft Save must PATCH the draft route (never correct)')
})

test('a posted report Edits by correcting: reason prompt, then the correction draft', async (t) => {
  const { requests } = await mountDrawer(t, {
    status: 'posted',
    canSubmit: true,
    canPost: true,
    canRecall: false,
    scripted: { canonicalDoc: makeDoc('posted') },
    promptResult: 'correct the travel total after the final receipts',
  })
  const edit = findButton('Edit')
  assert.ok(edit, 'a posted report must offer Edit with bill parity')
  await click(edit)
  assert.equal(script.confirmCalls, 0, 'posted edits correct — they do not recall')
  await openActions()
  const save = findButton('Save')
  assert.ok(save, 'a posted report Edits through the correction flow')
  await click(save)
  const correct = requests.find((r) => r.url === `/api/expenses/${REPORT_ID}/correct` && r.method === 'POST')
  const body = (correct?.body ?? {}) as Record<string, unknown>
  assert.equal(body.amendmentReason, 'correct the travel total after the final receipts')
  assert.equal(body.expectedUpdatedAt, UPDATED_AT, 'the correction must carry the revision fence')
  assert.ok(Array.isArray(body.lines), 'the correction must carry the full edited content')
  assert.ok(
    script.pushed.some((url) => url.includes('expense=new-draft-id') && url.includes('mode=edit')),
    'after correcting, the drawer must route to the correction draft for continued editing',
  )
})

test('void sends the reason, selected reversal period, and exact loaded revision', async (t) => {
  const { requests } = await mountDrawer(t, {
    status: 'posted',
    canSubmit: false,
    canPost: true,
    canRecall: false,
    scripted: { canonicalDoc: makeDoc('posted') },
    promptResult: 'correct the final travel total',
  })
  await openActions()
  const voidButton = findButton('Void')
  assert.ok(voidButton, `posted expense reports with post access can be voided; buttons: ${[...document.querySelectorAll('button')].map((button) => button.textContent?.trim()).join(' | ')}`)
  await click(voidButton)
  const request = requests.find((entry) => entry.url === `/api/documents/${REPORT_ID}/void`)
  assert.deepEqual(request?.body, {
    reason: 'correct the final travel total',
    expectedUpdatedAt: UPDATED_AT,
    reversalPeriodId: 'period-1',
  })
})
