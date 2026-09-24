import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __setupCloseTestRouter: { push(url: string): void; refresh(): void; replace(url: string): void } | undefined
  var __closeTestToasts: { kind: string; message: string }[] | undefined
}

// jsdom first: the workspace reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/period-close?tab=periods',
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

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function useRouter(){return globalThis.__setupCloseTestRouter}export function usePathname(){return '/admin/setup/period-close'}export function useSearchParams(){return new URLSearchParams()}`,
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}`,
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast={success(m){(globalThis.__closeTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__closeTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}`,
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
const messages = (await import('../../../../../messages/en')).default
const closeSetup = (await import('../../../../../messages/en/close.json', { with: { type: 'json' } })).default
  .setup as unknown as Record<string, Record<string, string>>
const { CloseSetupWorkspace } = await import('./CloseSetupWorkspace')

type WorkspaceProps = Parameters<typeof CloseSetupWorkspace>[0]

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const BOOKS = [{ id: 'b1', name: 'Main' }]
const CALENDARS = [{ id: 'cal-1', name: 'Gregorian', is_default: true, is_active: true }]

function baseProps(params: Record<string, string | string[] | undefined>): WorkspaceProps {
  return {
    currentParams: params,
    fiscalYear: 2026,
    periodPage: 1,
    periodPerPage: 20,
    periodTotal: 0,
    configLists: {},
    configPerPage: 20,
    calendars: [],
    calendarOptions: CALENDARS,
    periods: [],
    books: BOOKS,
    selectedBookId: 'b1',
    canReopen: true,
    blueprints: [],
    policies: [],
    automations: [],
    packages: [],
    users: [],
    roles: [],
    reportDefs: [],
    subsidiaries: [],
    dimensions: { departments: [], projects: [], locations: [], classes: [] },
    reopenRequests: [],
    reopenPage: 1,
    reopenTotal: 0,
    reopenPerPage: 20,
    advancedClose: false,
  } as unknown as WorkspaceProps
}

async function mountWorkspace(props: WorkspaceProps) {
  const pushes: string[] = []
  globalThis.__setupCloseTestRouter = {
    push(url: string) {
      pushes.push(url)
    },
    refresh() {},
    replace() {},
  }
  globalThis.__closeTestToasts = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CloseSetupWorkspace {...props} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  return {
    pushes,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function clickButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === name,
  ) as HTMLButtonElement | undefined
  assert.ok(button, `expected a ${name} button`)
  return button
}

const GENERATE = String(closeSetup.actions?.generate ?? 'Generate periods')

test('period generation failure keeps the drawer open and renders the server reason', async () => {
  const reason = 'FY2026 has ledger activity and its dates cannot be regenerated'
  const prior = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ error: reason }, { status: 422 })) as typeof fetch
  const { pushes, unmount } = await mountWorkspace(baseProps({ tab: 'periods', period: 'new' }))
  try {
    await act(async () => {
      clickButton(GENERATE).click()
      await tick()
      await tick()
    })
    const alert = document.querySelector('p[role="alert"]')
    assert.ok(alert, 'the generate drawer must persist the failure as an alert')
    assert.equal(alert?.textContent, reason, 'the alert carries the server reason verbatim')
    assert.deepEqual(pushes, [], 'a failed generate must not navigate away')
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

test('period generation navigates away only on success', async () => {
  const prior = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch
  const { pushes, unmount } = await mountWorkspace(baseProps({ tab: 'periods', period: 'new' }))
  try {
    await act(async () => {
      clickButton(GENERATE).click()
      await tick()
      await tick()
    })
    assert.equal(pushes.length, 1, 'exactly one post-generate navigation (the success path)')
    assert.match(pushes[0] ?? '', /fy=2026/, 'success returns to the generated year')
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

test('period drawer surfaces pending reopen requests for its period and book', async () => {
  const props = baseProps({ tab: 'periods', period: 'p1' })
  const period = {
    id: 'p1',
    name: 'Jan 2026',
    starts_on: '2026-01-01',
    ends_on: '2026-01-31',
    entries: 0,
    locks: {},
    calendar_name: 'Gregorian',
  }
  const mine = {
    id: 'r1',
    period_id: 'p1',
    book_id: 'b1',
    status: 'requested',
    reason: 'close the gap week first',
    modules: ['gl'],
    period_name: 'Jan 2026',
    book_name: 'Main',
    requester_name: 'Rae',
    approver_name: null,
  }
  const decided = { ...mine, id: 'r2', status: 'approved', reason: 'already decided' }
  const otherPeriod = { ...mine, id: 'r3', period_id: 'p9', reason: 'another period' }
  const withRows = {
    ...props,
    periods: [period],
    reopenRequests: [mine, decided, otherPeriod],
  } as unknown as WorkspaceProps
  const { unmount } = await mountWorkspace(withRows)
  try {
    const body = document.body.textContent ?? ''
    assert.ok(body.includes(mine.reason), 'the pending request for this period+book renders')
    assert.ok(!body.includes(decided.reason), 'a decided request is not pending')
    assert.ok(!body.includes(otherPeriod.reason), 'another period request stays out')
  } finally {
    await unmount()
  }
})
