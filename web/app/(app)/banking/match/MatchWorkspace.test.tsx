import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F-t05-017 (rule-suggestion chip) + F-t05-019 (add-journal dialog): both
// refusal paths 422 with zero user feedback. The routes answer typed
// { error } bodies, but MatchWorkspace.call() read the body with a bare
// res.json: an unreadable error body threw, the toast never fired, and the
// failure went silent. The helper now mirrors the documents row-action
// hardening — the read can never throw and a refusal always toasts.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/banking/match?account=acc-1',
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
  // Desktop viewport: the pickers render dropdowns (the testers' 1440px
  // path) instead of the mobile bottom sheet.
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  applyLineBody: '' as string,
  createMatchBody: '' as string,
}
Object.assign(globalThis, {
  __matchTestToasts: script.toasts,
  __matchTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__matchTestRouter}export function usePathname(){return "/banking/match"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__matchTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__matchTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__matchTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
      }
    }
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){return true};export async function promptDialog(){return null}',
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
const { MatchWorkspace } = await import('./MatchWorkspace')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const STMT_ID = 'stmt-1'
const OFFSET_ID = '019f0000-0000-4000-8000-000000000005'

const data = {
  stmtRows: [{ id: STMT_ID, posted_on: '2026-06-15', amount: '-25.00', description: 'T05MATCH fee' }],
  stmtTotal: 1,
  stmtParams: { page: 1, perPage: 25 },
  flaggedTotal: 0,
  glRows: [],
  glTotal: 0,
  glParams: { page: 1, perPage: 25 },
  reviewRows: [],
  excludedRows: [],
  excludedTotal: 0,
  exParams: { page: 1, perPage: 25 },
}

async function mountWorkspace(t: TestContext, fetchImpl: typeof fetch, dataOverride: typeof data = data): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = fetchImpl
  t.after(() => {
    globalThis.fetch = prior
  })
  // The picker dropdown portals to document.body, outside any host div —
  // and React only hears events that bubble through its root container — so
  // the root IS the body here. Portaled option clicks would otherwise never
  // reach React (the F-t05-019 dialog peccadillo).
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  script.toasts.length = 0
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <MatchWorkspace
            accounts={[{ id: 'acc-1', label: '1000 Operating Cash' }]}
            offsetAccounts={[{ id: OFFSET_ID, label: '6800 Bank & Merchant Fees' }]}
            account={{ id: 'acc-1', label: '1000 Operating Cash' }}
            session={{ id: 'rec-1', throughDate: '2026-09-10', statementBalance: '17070.01', currency: 'CAD' }}
            data={dataOverride}
            totals={{ statementBalance: '17070.01', clearedBalance: '17070.01', difference: '0.00' }}
            currentParams={{}}
            tab="match"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
}

function scriptedFetch(handlers: Record<string, (url: string, body?: string) => Response>): typeof fetch {
  return (async (url: unknown, init?: { method?: string; body?: string }) => {
    const target = String(url)
    for (const [key, handler] of Object.entries(handlers)) {
      if (target.includes(key)) return handler(target, init?.body)
    }
    return Response.json({})
  }) as typeof fetch
}

const previewOk = () => Response.json({
  matches: [{ action: 'categorize', ruleMode: 'suggest', ruleId: 'rule-1', ruleName: 'Fee rule', lineId: STMT_ID }],
})

test('the account SearchSelect is associated with its translated label', async (t) => {
  await mountWorkspace(t, scriptedFetch({ '/rules/preview': () => Response.json({ matches: [] }) }))
  const label = [...document.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === 'Account')
  assert.ok(label, 'account label renders')
  assert.ok(label.control, 'account label controls the SearchSelect trigger')
  assert.equal(label.control.getAttribute('aria-label'), 'Account')
})

function suggestionChip(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Fee rule'))
  assert.ok(found, 'the suggested-rule chip must render')
  return found as HTMLButtonElement
}

function addJournalButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button[title]')].find((b) => b.getAttribute('title') === 'Add journal')
  assert.ok(found, 'the row must offer Add journal')
  return found as HTMLButtonElement
}

test('a refused rule suggestion surfaces the server reason (F-t05-017)', async (t) => {
  await mountWorkspace(t, scriptedFetch({
    '/rules/preview': previewOk,
    '/rules/apply-line': () => Response.json({ error: 'rule requires a mapped offset account' }, { status: 422 }),
  }))
  await act(async () => {
    suggestionChip().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error' && toast.message.includes('mapped offset account')),
    `the refusal must surface, got ${JSON.stringify(script.toasts)}`,
  )
})

test('an unreadable rule refusal still toasts (F-t05-017)', async (t) => {
  await mountWorkspace(t, scriptedFetch({
    '/rules/preview': previewOk,
    '/rules/apply-line': () => new Response('', { status: 422 }),
  }))
  await act(async () => {
    suggestionChip().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error'),
    `an empty-body 422 must still toast, got ${JSON.stringify(script.toasts)}`,
  )
})

test('a refused add-journal surfaces the server reason (F-t05-019)', async (t) => {
  await mountWorkspace(t, scriptedFetch({
    '/rules/preview': () => Response.json({ matches: [] }),
    '/create-match': () => Response.json({ error: 'offset account is not postable' }, { status: 422 }),
  }))
  await act(async () => {
    addJournalButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
  const dialogs = document.querySelectorAll('[role="dialog"]')
  const dialog = dialogs[dialogs.length - 1] as HTMLElement
  assert.ok(dialog, 'the add-journal dialog must open')
  const trigger = dialog.querySelector('button[aria-haspopup="listbox"]')
  assert.ok(trigger, 'the dialog must offer the offset picker')
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  const option = [...document.querySelectorAll('button[role="option"]')].find(
    (b) => (b.textContent ?? '').includes('6800 Bank & Merchant Fees'),
  )
  assert.ok(option, 'the picker must list the offset account')
  await act(async () => {
    ;(option as HTMLElement).click()
    await tick()
    await tick()
  })
  const add = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Add journal') as HTMLButtonElement | undefined
  assert.ok(add, 'the dialog must offer Add journal once an offset is picked')
  assert.equal(add.disabled, false, 'picking the offset must enable Add journal')
  await act(async () => {
    add.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error' && toast.message.includes('not postable')),
    `the refusal must surface, got ${JSON.stringify(script.toasts)}`,
  )
})

test('a refused add-journal persists the reason inline and releases busy (F-t05-019)', async (t) => {
  await mountWorkspace(t, scriptedFetch({
    '/rules/preview': () => Response.json({ matches: [] }),
    '/create-match': () => Response.json({ error: 'offset account is not postable' }, { status: 422 }),
  }))
  await act(async () => {
    addJournalButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
  const dialogs = document.querySelectorAll('[role="dialog"]')
  const dialog = dialogs[dialogs.length - 1] as HTMLElement
  assert.ok(dialog, 'the add-journal dialog must open')
  const trigger = dialog.querySelector('button[aria-haspopup="listbox"]')
  assert.ok(trigger, 'the dialog must offer the offset picker')
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  const option = [...document.querySelectorAll('button[role="option"]')].find(
    (b) => (b.textContent ?? '').includes('6800 Bank & Merchant Fees'),
  )
  assert.ok(option, 'the picker must list the offset account')
  await act(async () => {
    ;(option as HTMLElement).click()
    await tick()
    await tick()
  })
  const add = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Add journal') as HTMLButtonElement | undefined
  assert.ok(add, 'the dialog must offer Add journal once an offset is picked')
  await act(async () => {
    add.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
  // The dialog stays open (nothing matched) — but the typed refusal must
  // persist inline, not vanish with a transient toast (F-t05-019).
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the refused dialog must persist a role=alert')
  assert.ok(
    (alert.textContent ?? '').includes('not postable'),
    `the alert must carry the typed reason, got ${JSON.stringify(alert.textContent)}`,
  )
  const addAfter = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Add journal') as HTMLButtonElement | undefined
  assert.ok(addAfter, 'the dialog must still offer Add journal after the refusal')
  assert.equal(addAfter.disabled, false, 'busy must release after the refusal')
})

test('a flagged line shows its duplicate evidence with a clear action and a bulk exclude', async (t) => {
  const calls: { url: string; body?: string }[] = []
  const flaggedData = {
    ...data,
    stmtRows: [{
      id: STMT_ID,
      posted_on: '2026-09-01',
      amount: '-5.00',
      description: 'COFFEE SHOP',
      possible_duplicate_of: 'stmt-0',
      dup_posted_on: '2026-09-01',
      dup_amount: '-5.00',
      dup_description: 'COFFEE SHOP',
    }],
    flaggedTotal: 1,
  }
  await mountWorkspace(t, scriptedFetch({
    '/rules/preview': () => Response.json({ matches: [] }),
    '/statement-lines/stmt-1': (url, body) => {
      calls.push({ url, body })
      return Response.json({ ok: true })
    },
  }), flaggedData)
  assert.ok(
    [...document.querySelectorAll('*')].some((el) => (el.textContent ?? '').includes('Possible duplicate')),
    'the flagged row must carry its duplicate badge',
  )
  assert.ok(
    [...document.querySelectorAll('*')].some((el) => (el.textContent ?? '').includes('2026-09-01')),
    'the badge must name the earlier line it may duplicate',
  )
  const clear = [...document.querySelectorAll('button[title]')].find((b) => b.getAttribute('title') === 'Mark as not a duplicate')
  assert.ok(clear, 'the flagged row must offer a clear action')
  const bulk = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Exclude 1 duplicates'))
  assert.ok(bulk, 'the toolbar must offer the bulk exclude with its count')
  await act(async () => {
    ;(clear as HTMLButtonElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
  assert.ok(
    calls.some((c) => c.url.includes('/statement-lines/stmt-1') && (c.body ?? '').includes('clear-duplicate')),
    `clearing must call the clear action, got ${JSON.stringify(calls)}`,
  )
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success'),
    `clearing must toast success, got ${JSON.stringify(script.toasts)}`,
  )
})
