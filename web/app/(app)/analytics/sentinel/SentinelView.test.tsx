import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { SentinelData } from '../../../../lib/analytics/sentinel-data'

// Flagged-document CSVs must carry exact amounts: the export passes the
// detected document amounts straight through instead of rounding them.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/analytics/sentinel',
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__svRouter}export function usePathname(){return \'/analytics/sentinel\'}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === '@openbooks/analytics/viz') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function InsightChart(){return null}export function InsightResultView(){return null}',
      }
    }
    return next(specifier, context)
  },
})

declare global {
  var __svRouter: { push(url: string): void; refresh(): void } | undefined
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { SentinelView } = await import('./SentinelView')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function fixture(): SentinelData {
  return {
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    meta: { totalDocs: 1, totalAmount: 1234.567, presentationCurrency: 'USD', days: 31, queryMs: 120 },
    config: {},
    summary: {
      flaggedCount: 1,
      duplicateCount: 0,
      totalDuplicateAmount: 0,
      weekendCount: 0,
      weekendAmount: 0,
      rsfCount: 0,
      zScoreCount: 0,
      sequentialGroups: 0,
      ghostCount: 0,
      trapCount: 0,
      totalAtRisk: 1234.567,
      overallRiskScore: 40,
      benfordConformity: 'acceptable',
      benford2DConformity: 'acceptable',
      approvalLimitRisk: false,
      topRiskAreas: [],
    },
    duplicates: { total: 0, pairs: [], groups: [] },
    benford1D: { totalTransactions: 1, digits: [], mad: 0, conformity: 'acceptable', message: '', byCurrency: [] },
    benford2D: { totalTransactions: 1, digits: [], anomalies: [], mad: 0, conformity: 'acceptable', byCurrency: [] },
    thresholdTrap: { total: 0, totalAmount: 0, byTrap: [], items: [] },
    weekend: { total: 0, totalAmount: 0, saturday: 0, sunday: 0, items: [] },
    rsf: { total: 0, items: [] },
    zscore: { total: 0, items: [] },
    sequential: [],
    ghosts: [],
    auditTrail: { total: 0, deletes: 0, sensitiveChanges: 0, events: [] },
    flagged: [
      {
        docId: 'd-1',
        docNumber: 'BILL-2049',
        kind: 'vendor_bill',
        date: '2026-07-14',
        amount: 1234.567,
        currency: 'USD',
        funcAmount: 1234.567,
        partyId: 'p-1',
        partyName: 'Acme Supplies',
        flagType: 'weekend',
        reason: 'Posted on a Sunday',
        riskScore: 65,
      },
    ],
    vendorRisk: [],
    calendar: [],
  } as unknown as SentinelData
}

function providers(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <BusinessDateProvider today="2026-08-28">{ui}</BusinessDateProvider>
      </MoneyProvider>
    </NextIntlClientProvider>
  )
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

test('sentinel CSV exports retain flagged document amount decimals', async () => {
  globalThis.__svRouter = { push() {}, refresh() {} }
  let blob: Blob | undefined
  let downloadedFile = ''
  let clickedHref = ''
  const realCreateObjectURL = URL.createObjectURL
  const realRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = (value: Blob) => {
    blob = value
    return 'blob:sentinel-export-test'
  }
  URL.revokeObjectURL = () => {}
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<SentinelView data={fixture()} />))
      await tick()
    })
    await tick()
    const detectionTab = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Detection'))
    assert.ok(detectionTab, 'the detection tab must exist')
    await click(detectionTab)
    const realCreate = document.createElement.bind(document)
    document.createElement = ((tag: string, opts?: ElementCreationOptions) => {
      const el = realCreate(tag, opts)
      if (tag === 'a') {
        const anchor = el as HTMLAnchorElement
        anchor.click = () => {
          clickedHref = anchor.href
          downloadedFile = anchor.download
        }
      }
      return el
    }) as typeof document.createElement
    try {
      const exportButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CSV'))
      assert.ok(exportButton, 'the flagged-documents table must offer a CSV export')
      await click(exportButton)
    } finally {
      document.createElement = realCreate
    }
    assert.ok(blob, 'clicking export must produce a download blob')
    const text = await blob!.text()
    assert.ok(text.includes('1234.567'), `flagged amount must stay decimal, got:\n${text}`)
    assert.ok(text.includes('BILL-2049'), `the flagged document must be in the export, got:\n${text}`)
    assert.ok(!text.includes('1235'), `flagged amount must not be rounded, got:\n${text}`)
    assert.equal(downloadedFile, 'flagged-documents-2026-08-28.csv')
    assert.equal(clickedHref, 'blob:sentinel-export-test')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    URL.createObjectURL = realCreateObjectURL
    URL.revokeObjectURL = realRevokeObjectURL
  }
})
