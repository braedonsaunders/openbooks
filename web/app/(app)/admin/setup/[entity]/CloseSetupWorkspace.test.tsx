import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __setupCloseTestRouter: { push(url: string): void; refresh(): void; replace(url: string): void } | undefined
  var __closeTestToasts: { kind: string; message: string }[] | undefined
}

// jsdom first: the workspace reads browser globals at render.
const { bootJsdomEnvironment } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/setup/period-close?tab=periods', matchMediaMatches: false, scrollIntoView: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__setupCloseTestRouter}export function usePathname(){return \'/admin/setup/period-close\'}export function useSearchParams(){return new URLSearchParams()}' })
registerHooks({
  resolve(specifier, context, next) {

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

test('report package remove controls have names that identify each report', async () => {
  const list = { page: 1, total: 0 }
  const props = {
    ...baseProps({ tab: 'packages', package: 'new' }),
    advancedClose: true,
    configLists: { calendar: list, blueprint: list, policy: list, automation: list, package: list },
  }
  const { unmount } = await mountWorkspace(props)
  try {
    const removeControls = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove "]')]
    assert.equal(removeControls.length, 5, 'every default attached report can be identified for removal')
    assert.ok(removeControls.every((button) => button.getAttribute('aria-label')!.length > 'Remove '.length))
  } finally {
    await unmount()
  }
})

function setNativeValue(element: HTMLElement, value: string) {
  const prototype = element instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function partiallyClosedPeriod() {
  return {
    id: 'p1',
    name: 'Dec 2025',
    starts_on: '2025-12-01',
    ends_on: '2025-12-31',
    entries: 3,
    locks: {
      ar: { state: 'closed' },
      ap: { state: 'closed' },
      banking: { state: 'open' },
      assets: { state: 'closed' },
      tax: { state: 'closed' },
      gl: { state: 'open' },
    },
    calendar_name: 'Gregorian',
  }
}

async function openCloseAllPanel(props: WorkspaceProps) {
  const { pushes, unmount } = await mountWorkspace(props)
  await act(async () => {
    clickButton(String(closeSetup.actions?.closeAll)).click()
    await tick()
  })
  const reasonBox = document.querySelector('textarea')
  assert.ok(reasonBox, 'the close-all panel asks for one shared reason')
  return { pushes, unmount, reasonBox: reasonBox as HTMLTextAreaElement }
}

/** A close submit that cannot send must say why instead of dying silently:
 * with no book in scope the request never leaves the browser, so the
 * drawer persists the remedy inline and as a toast. */
test('close-all without a book sends nothing and names the missing scope', async () => {
  const calls: string[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input))
    return Response.json({ ok: true, results: [] })
  }) as typeof fetch
  const props = {
    ...baseProps({ tab: 'periods', period: 'p1' }),
    books: [],
    selectedBookId: '',
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps
  const { unmount, reasonBox } = await openCloseAllPanel(props)
  try {
    await act(async () => {
      setNativeValue(reasonBox, 'December re-close control')
      await tick()
    })
    await act(async () => {
      clickButton(String(closeSetup.actions?.confirmClose)).click()
      await tick()
    })
    assert.deepEqual(calls, [], 'no request may leave the browser without a book')
    assert.equal(
      document.querySelector('p[role="alert"]')?.textContent,
      closeSetup.periods?.closeUnavailable,
      'the drawer names the missing scope inline',
    )
    const errors = (globalThis.__closeTestToasts ?? []).filter((toast) => toast.kind === 'error')
    assert.equal(errors.length, 1, 'exactly one error toast names the missing scope')
    assert.equal(errors[0]?.message, closeSetup.periods?.closeUnavailable)
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

/** A refused close-period keeps the panel open with the server text: the
 * operator sees which module blocked and why, not an empty alert. */
test('close-period refusal persists the server reason and keeps the panel open', async () => {
  const reason = 'close BANKING before GL'
  const prior = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ error: reason }, { status: 422 })) as typeof fetch
  const props = {
    ...baseProps({ tab: 'periods', period: 'p1' }),
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps
  const { pushes, unmount, reasonBox } = await openCloseAllPanel(props)
  try {
    await act(async () => {
      setNativeValue(reasonBox, 'December re-close control')
      await tick()
    })
    await act(async () => {
      clickButton(String(closeSetup.actions?.confirmClose)).click()
      await tick()
      await tick()
    })
    assert.equal(document.querySelector('p[role="alert"]')?.textContent, reason, 'the refusal text renders verbatim')
    assert.ok(
      [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === String(closeSetup.actions?.confirmClose)),
      'the panel stays open for the retry',
    )
    assert.deepEqual(pushes, [], 'a refused close must not navigate away')
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

/** A hung close request must not wedge the drawer: the timeout surfaces a
 * visible error and releases the form for a checked retry. */
test('close-period timeout surfaces the timeout remedy and releases the form', async () => {
  const prior = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new DOMException('The operation was aborted', 'AbortError')
  }) as typeof fetch
  const props = {
    ...baseProps({ tab: 'periods', period: 'p1' }),
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps
  const { unmount, reasonBox } = await openCloseAllPanel(props)
  try {
    await act(async () => {
      setNativeValue(reasonBox, 'December re-close control')
      await tick()
    })
    await act(async () => {
      clickButton(String(closeSetup.actions?.confirmClose)).click()
      await tick()
      await tick()
    })
    assert.equal(
      document.querySelector('p[role="alert"]')?.textContent,
      closeSetup.periods?.requestTimedOut,
      'the timeout remedy renders inline',
    )
    assert.equal(
      clickButton(String(closeSetup.actions?.confirmClose)).disabled,
      false,
      'the form releases for a checked retry',
    )
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

test('reopen approval preserves an independent-approval refusal and releases the action', async () => {
  const props = baseProps({ tab: 'periods', reopen: 'r1' })
  props.reopenRequests = [{ id: 'r1', period_id: 'p1', book_id: 'b1', status: 'requested', reason: 'correct the closing entry', modules: ['gl'], period_name: 'January', book_name: 'Main', requester_name: 'Rae', approver_name: null }] as WorkspaceProps['reopenRequests']
  const reason = 'a reopen request requires independent approval'
  const prior = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ error: reason }, { status: 422 })) as typeof fetch
  const { pushes, unmount } = await mountWorkspace(props)
  try {
    await act(async () => { clickButton(String(closeSetup.actions?.approve)).click(); await tick() })
    assert.equal(document.querySelector('p[role="alert"]')?.textContent, reason)
    assert.equal(clickButton(String(closeSetup.actions?.approve)).disabled, false)
    assert.deepEqual(pushes, [])
  } finally { await unmount(); globalThis.fetch = prior }
})
