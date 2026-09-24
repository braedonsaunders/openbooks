import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

declare global {
  var __depreciationToasts: { kind: string; message: string }[] | undefined
  var __depreciationRouter: { refresh(): void } | undefined
}

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4800/assets',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.requestAnimationFrame !== 'function') {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (typeof globals.ResizeObserver !== 'function') {
  globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__depreciationRouter}export function usePathname(){return '/assets'}export function useSearchParams(){return new URLSearchParams()}",
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__depreciationToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__depreciationToasts??=[]).push({kind:'error',message:String(m)})}}",
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
const { RunDepreciationDrawer } = await import('./RunDepreciationDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 40))

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>

async function mountDrawer(t: TestContext, fetchHandler: FetchHandler) {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(String(input), init)) as typeof fetch
  globalThis.__depreciationToasts = []
  globalThis.__depreciationRouter = { refresh() {} }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = priorFetch
  })

  const props: React.ComponentProps<typeof RunDepreciationDrawer> = {
    books: [{ id: 'book-1', name: 'Corporate', is_primary: true }],
    candidates: [],
    periods: [{ id: 'period-1', name: 'August 2026', startsOn: '2026-08-01', endsOn: '2026-08-31' }],
    lockAsset: { id: 'asset-1', number: 'FA-17', name: 'Forklift' },
    open: true,
    onClose() {},
  }
  await act(async () => {
    root.render(
      React.createElement(
        NextIntlClientProvider,
        { locale: 'en', messages, timeZone: 'UTC' } as unknown as React.ComponentProps<typeof NextIntlClientProvider>,
        React.createElement(
          MoneyProvider,
          { currency: 'USD' } as React.ComponentProps<typeof MoneyProvider>,
          React.createElement(RunDepreciationDrawer, props),
        ),
      ),
    )
    await tick()
  })
  return host
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  assert.ok(button, `expected visible ${label} action`)
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
}

function alertsText(): string {
  return [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? '').join(' ')
}

const PREVIEW = {
  asOfDate: '2026-08-31',
  bookId: 'book-1',
  periodId: 'period-1',
  postingDate: '2026-08-31',
  rows: [{
    lineId: 'line-1', assetId: 'asset-1', assetNumber: 'FA-17', assetName: 'Forklift',
    subsidiaryId: 'sub-1', subsidiaryName: 'North', departmentId: null, departmentName: null,
    projectId: null, projectName: null, locationId: null, locationName: null,
    bookId: 'book-1', bookName: 'Corporate', postsGl: true,
    periodId: 'period-1', periodName: 'August 2026', periodEndsOn: '2026-08-31',
    amount: '25.00', debitAccountId: 'account-expense', debitAccountNumber: '6010',
    debitAccountName: 'Depreciation expense', creditAccountId: 'account-accumulated',
    creditAccountNumber: '1590', creditAccountName: 'Accumulated depreciation',
    accountsResolved: true, evidence: 'gl-posting',
  }],
  totalAmount: '25.00', totalDebits: '25.00', totalCredits: '25.00', balanced: true,
  staleAssets: [], warnings: [], fingerprint: 'independent-preview-fingerprint',
}

async function preview(fetchHandler: FetchHandler, t: TestContext) {
  const host = await mountDrawer(t, fetchHandler)
  await clickButton('Preview')
  return host
}

test('preview refusals name the date remedy in the drawer and toast', async (t) => {
  await preview(async (url) => {
    assert.equal(url, '/api/assets/depreciation-preview')
    return Response.json({ error: 'invalid_through_date' }, { status: 400 })
  }, t)

  assert.match(alertsText(), /Use a calendar date \(YYYY-MM-DD\)\./)
  assert.deepEqual(globalThis.__depreciationToasts, [
    { kind: 'error', message: 'Use a calendar date (YYYY-MM-DD).' },
  ])
})

test('preview and confirm transport failures stay visible and release the actions', async (t) => {
  let calls = 0
  await mountDrawer(t, async (url) => {
    calls += 1
    if (url === '/api/assets/depreciation-preview' && calls === 1) throw new TypeError('offline')
    if (url === '/api/assets/depreciation-preview') return Response.json(PREVIEW)
    if (url === '/api/assets/run-depreciation') throw new TypeError('offline')
    throw new Error(`unexpected request: ${url}`)
  })

  await clickButton('Preview')
  assert.match(alertsText(), /Preview failed/)
  assert.deepEqual(globalThis.__depreciationToasts, [{ kind: 'error', message: 'Preview failed' }])

  await clickButton('Preview')
  await clickButton('Confirm and post')
  assert.match(alertsText(), /Posting failed/)
  assert.deepEqual(globalThis.__depreciationToasts, [
    { kind: 'error', message: 'Preview failed' },
    { kind: 'error', message: 'Posting failed' },
  ])
})

test('stale schedules block Confirm and a refused rebuild explains the next step', async (t) => {
  const stalePreview = {
    ...PREVIEW,
    rows: [],
    staleAssets: [{ assetId: 'asset-1', assetNumber: 'FA-17', assetName: 'Forklift' }],
  }
  await preview(async (url) => {
    if (url === '/api/assets/depreciation-preview') return Response.json(stalePreview)
    if (url === '/api/assets/rebuild-schedules') {
      return Response.json({ error: 'schedules_stale' }, { status: 409 })
    }
    throw new Error(`unexpected request: ${url}`)
  }, t)

  assert.match(alertsText(), /Confirm is disabled: 1 schedule\(s\) need a rebuild \(FA-17\)\./)
  const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Confirm and post')
  assert.ok(confirm?.disabled, 'a stale in-scope schedule must block posting')
  await clickButton('Rebuild schedules')
  assert.match(alertsText(), /Schedules changed — rebuild, then preview again\./)
  assert.deepEqual(globalThis.__depreciationToasts, [
    { kind: 'error', message: 'Schedules changed — rebuild, then preview again.' },
  ])
})

test('confirm refusal names the closed period and asset', async (t) => {
  await preview(async (url) => {
    if (url === '/api/assets/depreciation-preview') return Response.json(PREVIEW)
    if (url === '/api/assets/run-depreciation') {
      return Response.json({ error: 'period_closed', asset: 'FA-17', period: 'August 2026' }, { status: 409 })
    }
    throw new Error(`unexpected request: ${url}`)
  }, t)
  await clickButton('Confirm and post')

  const remedy = 'Period August 2026 (FA-17) is closed — open it, then confirm again.'
  assert.match(alertsText(), new RegExp(remedy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.deepEqual(globalThis.__depreciationToasts, [{ kind: 'error', message: remedy }])
})

test('results separate posted entries, reporting-only recognitions, skips, and problems', async (t) => {
  await preview(async (url) => {
    if (url === '/api/assets/depreciation-preview') return Response.json(PREVIEW)
    if (url === '/api/assets/run-depreciation') {
      return Response.json({
        posted: 1, recorded: 1, recordedAmount: '12.34', skipped: 1, totalAmount: '25.00',
        entries: [{ assetId: 'asset-1', assetNumber: 'FA-17', period: 'August 2026', amount: '25.00', entryId: 'journal-17', lineId: 'line-1' }],
        recordedEntries: [{ assetId: 'asset-2', assetNumber: 'FA-18', period: 'August 2026', amount: '12.34', lineId: 'evidence-2' }],
        skippedAssets: [{ assetNumber: 'FA-19', period: 'August 2026', reason: 'No usable source schedule' }],
        problems: ['FA-20: depreciation expense account is missing'],
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }, t)
  await clickButton('Confirm and post')

  const body = document.body.textContent ?? ''
  assert.match(body, /Posted 1 entries totalling/)
  assert.match(body, /Recorded 1 reporting-only charges totalling/)
  assert.match(body, /1 skipped/)
  assert.match(body, /Journal entries/)
  assert.match(body, /Reporting-only recognitions/)
  assert.match(body, /Skipped/)
  assert.match(body, /No usable source schedule/)
  assert.match(body, /FA-20: depreciation expense account is missing/)
  assert.ok(document.querySelector('a[href*="txn=journal-17"]'), 'GL entries link to their posted journal')
  assert.ok(document.querySelector('a[href="/assets?asset=asset-2"]'), 'reporting-only evidence links to its asset')
})

test('a zero-post run names the next planned asset and period', async (t) => {
  await preview(async (url) => {
    if (url === '/api/assets/depreciation-preview') return Response.json(PREVIEW)
    if (url === '/api/assets/run-depreciation') {
      return Response.json({
        posted: 0, skipped: 0, asOfDate: '2026-08-31',
        nextDue: { assetNumber: 'FA-17', period: 'September 2026', endsOn: '2026-09-30', amount: '25.00' },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }, t)
  await clickButton('Confirm and post')

  assert.match(document.body.textContent ?? '', /Nothing to post as of 2026-08-31\. Next: FA-17 September 2026/)
})
