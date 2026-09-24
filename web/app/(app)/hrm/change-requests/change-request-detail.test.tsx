import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

declare global {
  var __detailRouter: { push(url: string): void; refresh(): void; pushes: string[] } | undefined
}

// OM-12: the ?request=<id> drawer actually opens. These tests RENDER the
// dialog island with a stubbed fetch: a permitted id shows subject,
// proposed change, reason, history, and decision context with the existing
// lifecycle actions; an out-of-scope id shows the API's named refusal and
// no data; closing navigates the param away.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/hrm/change-requests',
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
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__detailRouter}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){}}',
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
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const { ChangeRequestDetailDialog } = await import('./ChangeRequestDetailDialog')
const hrmMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
const commonMessages = JSON.parse(readFileSync(new URL('../../../../messages/en/common.json', import.meta.url), 'utf8'))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type FetchHandler = (url: string) => Response | null

function stubFetch(handler: FetchHandler): () => void {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return handler(url) ?? Response.json({})
  }) as typeof fetch
  return () => {
    globalThis.fetch = prior
  }
}

const REQUEST_ID = randomUUID()

function draftHire(): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    employmentId: randomUUID(),
    payload: { kind: 'hire', status: 'active', effectiveFrom: '2026-09-01' },
    reason: null,
    action: null,
    reasonCode: null,
    status: 'draft',
    submittedBy: null,
    submittedAt: null,
    flowRunId: null,
    decisionSnapshot: null,
    appliedAt: null,
    appliedBy: null,
    appliedEmploymentChangeId: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    createdBy: randomUUID(),
    updatedAt: '2026-08-20T10:00:00.000Z',
    updatedBy: randomUUID(),
  }
}

const SUBJECT = {
  employeeLabel: 'Quinn Vidal',
  kindLabel: 'Hire',
  effectiveWindow: '2026-09-01 → Present',
  requesterLabel: 'Evelyn Admin',
  submittedLabel: 'Not available',
  statusLabel: 'Draft',
}

function provider(children: React.ReactNode): React.ReactNode {
  return (
    <NextIntlClientProvider locale="en" messages={{ hrm: hrmMessages, common: commonMessages }}>
      {children}
    </NextIntlClientProvider>
  )
}

async function mountDialog(opts: {
  requestId: string | null
  closeHref: string
  subject: typeof SUBJECT | null
  departmentOptions?: { value: string; label: string }[]
  fetchHandler: FetchHandler
}): Promise<{ unmount: () => Promise<void> }> {
  const pushes: string[] = []
  globalThis.__detailRouter = {
    push(url: string) {
      pushes.push(url)
    },
    refresh() {},
    pushes,
  }
  const restore = stubFetch(opts.fetchHandler)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      provider(
        <ChangeRequestDetailDialog
          requestId={opts.requestId}
          closeHref={opts.closeHref}
          subject={opts.subject}
          departmentOptions={opts.departmentOptions ?? []}
        />,
      ),
    )
    await sleep(50)
  })
  // The display-name lookups fire after the detail resolves: a second flush
  // settles them before any assertion reads a label.
  await act(async () => {
    await sleep(50)
  })
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      restore()
    },
  }
}

function textOf(): string {
  // The house Drawer portals to document.body, so assertions read the whole
  // document, never the mount host alone.
  return document.body.textContent ?? ''
}

function alertBox(): Element | null {
  return document.querySelector('[role="alert"]')
}

test('?request=<id> opens the drawer for a permitted request', async () => {
  const seen: string[] = []
  const { unmount } = await mountDialog({
    requestId: REQUEST_ID,
    closeHref: '/hrm/change-requests',
    subject: SUBJECT,
    fetchHandler: (url) => {
      seen.push(url)
      if (url === `/api/hrm/change-requests/${REQUEST_ID}`) {
        return Response.json({ request: draftHire() })
      }
      return null
    },
  })
  try {
    assert.ok(seen.includes(`/api/hrm/change-requests/${REQUEST_ID}`), 'the drawer reads the single-request route')
    const text = textOf()
    assert.match(text, /Quinn Vidal/, 'the drawer names the subject')
    assert.match(text, /Hire/, 'the drawer names the change kind')
    assert.match(text, /2026-09-01/, 'the drawer shows the proposed effective date verbatim')
    assert.match(text, /Active/, 'the drawer shows the proposed status')
    assert.match(text, /Filed/, 'the drawer shows the filing history')
    assert.match(text, /2026-08-20T10:00:00\.000Z/, 'the drawer shows the filing stamp')
    assert.match(text, /Draft — no approval run yet\./, 'a draft names its undecided state')
    assert.match(text, /Edit draft/, 'a draft carries its lifecycle actions inside the drawer')
    assert.equal(alertBox(), null, 'no refusal renders beside permitted data')
  } finally {
    await unmount()
  }
})

test('the drawer resolves proposed-change names, never ids alone', async () => {
  const departmentId = randomUUID()
  const locationId = randomUUID()
  const managerId = randomUUID()
  const { unmount } = await mountDialog({
    requestId: REQUEST_ID,
    closeHref: '/hrm/change-requests',
    subject: null,
    departmentOptions: [{ value: departmentId, label: 'Kitchen' }],
    fetchHandler: (url) => {
      if (url === `/api/hrm/change-requests/${REQUEST_ID}`) {
        return Response.json({
          request: {
            ...draftHire(),
            status: 'pending_approval',
            submittedBy: randomUUID(),
            submittedAt: '2026-08-21T09:00:00.000Z',
            flowRunId: randomUUID(),
            payload: {
              kind: 'assignment_change',
              assignmentKey: 'primary',
              jobTitle: 'Line cook',
              departmentId,
              locationId,
              fte: '0.8000',
              isPrimary: true,
              managerEmploymentId: managerId,
              effectiveFrom: '2026-10-01',
            },
          },
        })
      }
      if (url.includes('source=locations')) {
        return Response.json({ options: [{ locationId, label: 'Dining room' }] })
      }
      if (url.includes('source=employments')) {
        return Response.json({ options: [{ employmentId: managerId, label: 'Sous Chef Sam' }] })
      }
      return null
    },
  })
  try {
    const text = textOf()
    assert.match(text, /Kitchen/, 'the department resolves from the loader options')
    assert.match(text, /Dining room/, 'the location resolves over the options route')
    assert.match(text, /Sous Chef Sam/, 'the manager resolves over the options route')
    assert.match(text, /Line cook/, 'verbatim fields render untouched')
    assert.match(text, /0\.8000/, 'the FTE renders as the exact typed decimal text')
    assert.match(text, /Awaiting decision/, 'a pending run names its undecided state with the inbox link')
    assert.ok(!text.includes(locationId), 'no raw location id leaks into the display')
    assert.ok(!text.includes(managerId), 'no raw manager id leaks into the display')
  } finally {
    await unmount()
  }
})

test('the drawer shows the decision context of a decided request', async () => {
  const { unmount } = await mountDialog({
    requestId: REQUEST_ID,
    closeHref: '/hrm/change-requests',
    subject: SUBJECT,
    fetchHandler: (url) => {
      if (url === `/api/hrm/change-requests/${REQUEST_ID}`) {
        return Response.json({
          request: {
            ...draftHire(),
            status: 'approved',
            submittedBy: randomUUID(),
            submittedAt: '2026-08-21T09:00:00.000Z',
            flowRunId: randomUUID(),
            reason: 'Backfill for the dinner shift.',
            decisionSnapshot: {
              outcome: 'approved',
              flow_run_id: randomUUID(),
              gates: [
                {
                  gate_id: randomUUID(),
                  decision: 'approved',
                  decided_by: randomUUID(),
                  decided_at: '2026-08-22T09:00:00.000Z',
                  comment: 'References checked.',
                },
              ],
            },
            appliedAt: '2026-08-23T09:00:00.000Z',
          },
        })
      }
      return null
    },
  })
  try {
    const text = textOf()
    assert.match(text, /Backfill for the dinner shift\./, 'the drawer shows the stamped reason')
    assert.match(text, /Approved/, 'the drawer shows the decision outcome')
    assert.equal(
      (text.match(/Approved/g) ?? []).length,
      2,
      'the outcome and the gate decision both render the Approved label, never the raw approved code',
    )
    assert.match(text, /References checked\./, 'the drawer shows the gate comment')
    assert.match(text, /2026-08-22T09:00:00\.000Z/, 'the drawer shows when the gate decided')
    assert.match(text, /2026-08-23T09:00:00\.000Z/, 'the drawer shows when the decision applied')
    assert.ok(!/Edit draft/.test(text), 'a decided request carries no draft actions')
  } finally {
    await unmount()
  }
})

test('an out-of-scope id gives the named refusal, never the data', async () => {
  const refusal = 'that request is not visible in this organization — ask an HR administrator for access'
  const { unmount } = await mountDialog({
    requestId: REQUEST_ID,
    closeHref: '/hrm/change-requests',
    subject: null,
    fetchHandler: (url) => {
      if (url === `/api/hrm/change-requests/${REQUEST_ID}`) {
        return Response.json({ error: refusal }, { status: 403 })
      }
      return null
    },
  })
  try {
    const alert = alertBox()
    assert.ok(alert, 'the refusal renders as an alert')
    assert.ok((alert.textContent ?? '').includes(refusal), 'the refusal names the remedy intact')
    assert.equal(
      document.querySelector('[aria-label="Proposed change"]'),
      null,
      'no proposed change renders beside the refusal',
    )
    assert.equal(document.querySelector('[aria-label="History"]'), null, 'no history renders beside the refusal')
  } finally {
    await unmount()
  }
})

test('closing the drawer clears the request param', async () => {
  const closeHref = '/hrm/change-requests?status=draft'
  const { unmount } = await mountDialog({
    requestId: REQUEST_ID,
    closeHref,
    subject: SUBJECT,
    fetchHandler: (url) => {
      if (url === `/api/hrm/change-requests/${REQUEST_ID}`) {
        return Response.json({ request: draftHire() })
      }
      return null
    },
  })
  try {
    const close = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close')
    assert.ok(close, 'the drawer offers Close')
    await act(async () => {
      close.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await sleep(20)
    })
    assert.deepEqual(globalThis.__detailRouter?.pushes, [closeHref], 'closing navigates the param away')
  } finally {
    await unmount()
  }
})

test('no request id renders nothing', async () => {
  const { unmount } = await mountDialog({
    requestId: null,
    closeHref: '/hrm/change-requests',
    subject: null,
    fetchHandler: () => null,
  })
  try {
    assert.equal(textOf().trim(), '', 'the dialog stays closed without an id')
  } finally {
    await unmount()
  }
})
