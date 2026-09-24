import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll/yearend.ts'
import type { FilingLifecycle, FilingRowReview } from '../app/(app)/payroll/_ui/filing-amendments.tsx'

/**
 * Filing-cancellation evidence: cancelling an issued slip is an affirmative
 * statutory declaration, so the route refuses an unconfirmed or reason-less
 * cancellation before any write and persists the confirmed reason as the
 * filing note — and the correction section only offers cancellation behind
 * its reviewed preview, an explicit confirm, and a reason that belongs to
 * the current evidence context.
 */

const amendKey = Symbol.for('openbooks.filing-amendments-test')
const amendState: {
  granted: Set<string>
  issued: unknown[]
  confirmNext: boolean
  posted: Array<{ url: string; body: unknown }>
  confirms: number
} = { granted: new Set(), issued: [], confirmNext: true, posted: [], confirms: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[amendKey] = amendState

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`

const routeMocks = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      import { NextResponse } from 'next/server'
      const state = globalThis[Symbol.for('openbooks.filing-amendments-test')]
      export async function guardFeaturePermission(permission) {
        if (!state.granted.has(permission)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
        return { user: { orgId: 'org-1', id: 'user-1' }, permissions: state.granted, allowedSubsidiaryIds: null }
      }
    `,
  ],
  // The subsidiary-scope guard is our own module, so it is NOT stubbed: the
  // route exercises the real guard against the scripted feature gate below
  // (unrestricted scope) and a well-formed empty population. Only the auth
  // boundary (feature gates) and the engine service are scripted.
  [
    'mock:yearend',
    `
      export async function orgYearEndFilings() {
        return [{ country: 'CA', key: 't4', data: { rowKey: 'rowId', columns: [], rows: [] } }]
      }
    `,
  ],
  [
    'mock:yearend-amendments',
    `
      const state = globalThis[Symbol.for('openbooks.filing-amendments-test')]
      export async function filingLifecycle() { return { rows: [] } }
      export async function recordFilingIssue(input) {
        state.issued.push(input)
        return {
          submission: {
            id: 'sub-1', revision: input.revision, revisionNumber: 2,
            issuedAt: '2026-09-24T00:00:00Z', slipCount: 1, artifact: null,
          },
          fileRefusal: null,
        }
      }
    `,
  ],
])

const routeUrls = new Map<string, string>([
  ['../../../../../lib/feature-gates', mockUrl('feature-gates')],
  ['@openbooks/engine/src/payroll/yearend.ts', mockUrl('yearend')],
  ['@openbooks/engine/src/payroll/yearend-amendments.ts', mockUrl('yearend-amendments')],
])

const routeHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function getTranslations() { return (key) => key }',
      }
    }
    // The yearend population script is the route's boundary, but the real
  // subsidiary-scope guard imports roeSourceScope from the same module.
  // Only the route under test sees the script; every other importer (the
  // real guard) resolves the real module, so owned-module wiring stays
  // real and the stub never has to track the engine's exports.
  if (
    specifier === '@openbooks/engine/src/payroll/yearend.ts' &&
    !String(context.parentURL ?? '').includes('payroll/year-end/amendments/route.ts')
  ) {
    return nextResolve(specifier, context)
  }
  const mocked = routeUrls.get(specifier)
  if (mocked) return { url: mocked, shortCircuit: true }
  return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url)
    const name = parsed.searchParams.get('mock')
    const source = name ? routeMocks.get(`mock:${name}`) : undefined
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const amendmentsUrl = '../app/api/payroll/year-end/amendments/route.ts?filing-amendments-route'
const { POST } = (await import(amendmentsUrl)) as typeof import('../app/api/payroll/year-end/amendments/route.ts')
routeHooks.deregister()

function cancelPost(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/payroll/year-end/amendments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const CANCEL = {
  country: 'CA',
  filing: 't4',
  year: 2026,
  revision: 'cancelled',
}

test('an unconfirmed cancellation is refused before any write', async () => {
  amendState.granted = new Set(['payroll.run'])
  amendState.issued = []

  const response = await cancelPost({ ...CANCEL, reason: 'Duplicate slip' })

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'cancellation must be explicitly confirmed' })
  assert.deepEqual(amendState.issued, [])
})

test('a reason-less cancellation is refused before any write', async () => {
  amendState.granted = new Set(['payroll.run'])
  amendState.issued = []

  const response = await cancelPost({ ...CANCEL, confirmedCancellation: true, reason: '   ' })

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'a nonblank cancellation reason is required' })
  assert.deepEqual(amendState.issued, [])
})

test('a confirmed cancellation persists its trimmed reason as the filing note', async () => {
  amendState.granted = new Set(['payroll.run'])
  amendState.issued = []

  const response = await cancelPost({
    ...CANCEL,
    confirmedCancellation: true,
    reason: '  Employee belonged to the other entity  ',
  })

  assert.equal(response.status, 200)
  const issued = amendState.issued.at(-1) as { note: string; reason: string; revision: string }
  assert.equal(issued.revision, 'cancelled')
  assert.equal(issued.note, 'Employee belonged to the other entity')
  assert.equal(issued.reason, 'Employee belonged to the other entity')
  const body = (await response.json()) as { submission: { revision: string } }
  assert.equal(body.submission.revision, 'cancelled')
})

// --- FilingCorrectionSection (jsdom + the real section component) ---

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost:4800/' })
const sectionGlobals = globalThis as Record<string, unknown>
const sectionWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (sectionGlobals[key] === undefined) sectionGlobals[key] = sectionWindow[key]
}
if (typeof (dom.window as unknown as { matchMedia?: unknown }).matchMedia !== 'function') {
  ;(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })
}
{
  sectionGlobals.fetch = (async (url: string, init?: RequestInit) => {
    const href = String(url)
    if (href.includes('/amendments/slip?')) {
      return {
        ok: true,
        json: async () => ({
          slip: { formCode: 'GENERIC', formName: 'Slip', headerFields: [], boxes: [] },
          orgName: 'Test Org',
          currency: 'CAD',
        }),
      }
    }
    if (href.endsWith('/amendments') && (init?.method ?? 'GET') === 'POST') {
      amendState.posted.push({ url: href, body: JSON.parse(String(init?.body)) })
      return { ok: true, json: async () => ({ fileRefusal: null }) }
    }
    throw new Error(`unexpected section fetch: ${href}`)
  }) as typeof fetch
}

const sectionHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useTranslations() { const t = (key) => key; t.has = () => false; return t }',
      }
    }
    if (specifier === '../../../../components/money-provider') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useMoney() { return { money: (v) => String(v ?? "") } }',
      }
    }
    if (specifier === '../../../../lib/confirm') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export async function confirmDialog() { const s = globalThis[Symbol.for('openbooks.filing-amendments-test')]; s.confirms += 1; return s.confirmNext }`,
      }
    }
    return nextResolve(specifier, context)
  },
})

;(sectionGlobals as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { FilingCorrectionSection } = await import('../app/(app)/payroll/_ui/filing-amendments.tsx')
sectionHooks.deregister()

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

// Full render contracts: the section reads review status/revision/changes
// for its amend-or-cancel offers and the lifecycle's supported revisions,
// so partial shapes would lie about what is mounted. Added fields stay
// inert (empty rows, no file, same-form vehicle) to preserve the renders.
const REVIEW: FilingRowReview = {
  rowId: 'row-1',
  label: 'Test slip',
  status: 'changed',
  lastRevision: 'original',
  lastIssuedAt: null,
  changes: [],
}
// The section fixture carries the full render contract: the correction
// section reads country/key for its amendment URLs and label/data for the
// reviewed preview, so a partial shape would lie about what it mounts.
const SECTION: YearEndFilingSection = {
  country: 'CA',
  key: 't4',
  label: 'T4',
  cadence: 'annual',
  description: null,
  emptyText: null,
  installed: true,
  data: { columns: [], rows: [], rowKey: 'rowId' },
  hasSlip: false,
  populationRefusal: null,
  download: null,
  downloadRefusal: null,
  issue: null,
}
const LIFECYCLE: FilingLifecycle = {
  country: 'CA',
  filingKey: 't4',
  label: 'T4',
  taxYear: 2026,
  amendment: {
    supported: true,
    revisions: ['amended', 'cancelled'],
    vehicle: 'same_form',
    formLabel: null,
    download: null,
    downloadRefusal: null,
    hasSlip: false,
  },
  submissions: [],
  rows: [],
  populationRefusal: null,
}

// The mounted operator may file: canFile gates every amendment and
// cancellation act on main (a read-only caller is never offered them,
// covered by _ui/filing-permissions.test.tsx), so these evidence tests
// mount the filing operator's section.
function sectionProps(overrides: Record<string, unknown> = {}) {
  return {
    section: { ...SECTION },
    year: 2026,
    review: { ...REVIEW },
    lifecycle: { ...LIFECYCLE },
    canFile: true,
    onIssued() {},
    ...overrides,
  }
}

async function mountSection(props: ReturnType<typeof sectionProps>, onIssued: () => void = () => {}) {
  amendState.posted = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = async (next: ReturnType<typeof sectionProps>) => {
    await act(async () => {
      root.render(React.createElement(FilingCorrectionSection, { ...next, onIssued }))
      await tick()
    })
    await tick()
  }
  await render({ ...props, onIssued })
  return {
    host,
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement | null {
  return [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === text) ?? null
}

async function click(el: Element) {
  const MouseEventCtor = (dom.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent
  await act(async () => {
    el.dispatchEvent(new MouseEventCtor('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

async function typeReason(host: HTMLElement, value: string) {
  const area = host.querySelector('textarea#cancellation-reason-row-1') as HTMLTextAreaElement | null
  assert.ok(area, 'the cancellation reason field renders')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(area, value)
    area.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event('input', { bubbles: true }))
    await tick()
  })
  await tick()
}

test('cancellation cannot issue before its preview is reviewed', async (t) => {
  const { host, unmount } = await mountSection(sectionProps())
  t.after(unmount)
  const cancel = buttonByText(host, 'Cancel this slip')
  assert.ok(cancel, 'the cancellation action renders')
  await typeReason(host, 'Duplicate slip')
  assert.equal(
    buttonByText(host, 'Cancel this slip')!.disabled,
    true,
    'a reason alone does not unlock cancellation — the preview must be reviewed first',
  )
})

test('a reviewed cancellation with a reason issues with its evidence', async (t) => {
  amendState.confirmNext = true
  let issued = 0
  const { host, unmount } = await mountSection(sectionProps(), () => {
    issued += 1
  })
  t.after(unmount)
  await click(buttonByText(host, 'Preview cancellation')!)
  await typeReason(host, 'Duplicate slip')
  const cancel = buttonByText(host, 'Cancel this slip')!
  assert.equal(cancel.disabled, false, 'preview plus reason enables cancellation')
  await click(cancel)
  assert.equal(amendState.posted.length, 1)
  assert.deepEqual(amendState.posted[0]!.body, {
    country: 'CA',
    filing: 't4',
    year: 2026,
    revision: 'cancelled',
    rowIds: ['row-1'],
    confirmedCancellation: true,
    reason: 'Duplicate slip',
  })
  assert.equal(issued, 1, 'the section reports the issue')
})

test('declining the confirm aborts without posting', async (t) => {
  amendState.confirmNext = false
  amendState.confirms = 0
  const { host, unmount } = await mountSection(sectionProps())
  t.after(unmount)
  await click(buttonByText(host, 'Preview cancellation')!)
  await typeReason(host, 'Duplicate slip')
  await click(buttonByText(host, 'Cancel this slip')!)
  assert.equal(amendState.confirms, 1, 'the destructive act asks first')
  assert.deepEqual(amendState.posted, [], 'no correction posts without explicit confirmation')
})

test('a new evidence context clears the stale reason', async (t) => {
  const { host, render, unmount } = await mountSection(sectionProps())
  t.after(unmount)
  await click(buttonByText(host, 'Preview cancellation')!)
  await typeReason(host, 'stale explanation')
  await render(sectionProps({ review: { ...REVIEW, lastRevision: 'amended' } }))
  const area = host.querySelector('textarea#cancellation-reason-row-1') as HTMLTextAreaElement | null
  assert.ok(area, 'the reason field renders after the context change')
  assert.equal(area.value, '', 'the stale reason does not survive the evidence change')
})
