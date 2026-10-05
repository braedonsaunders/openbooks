import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { SentinelData } from '../../../../lib/analytics/sentinel-data'

// Flagged-document CSVs must carry exact amounts: the export passes the
// detected document amounts straight through instead of rounding them.

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/analytics/sentinel', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__svRouter}export function usePathname(){return \'/analytics/sentinel\'}export function useSearchParams(){return new URLSearchParams()}' })
registerHooks({
  resolve(specifier, context, next) {

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

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { SentinelView } = await import('./SentinelView')
const { RISK_SCORING } = await import('../../../../lib/analytics/sentinel-data')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function fixture(): SentinelData {
  return {
    scoring: RISK_SCORING,
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    meta: { totalDocs: 1, totalAmount: '1234.5670', presentationCurrency: 'USD', days: 31, queryMs: 120 },
    config: {
      duplicateDays: 14,
      duplicateMinAmount: '100.0000',
      sequentialMinCount: 3,
      sequentialMinDays: 7,
      moderateRiskAmount: '1000.0000',
      highRiskAmount: '10000.0000',
      criticalRiskAmount: '25000.0000',
      aggregateHighAmount: '50000.0000',
      aggregateCriticalAmount: '100000.0000',
      rsfBaselineFloor: '100.0000',
      zscoreSigmaFloor: '10.0000',
      zscoreThreshold: 3,
      zscoreMinBaseline: 5,
      rsfThreshold: 10,
      baselineMonths: 36,
      sequentialHighRiskDays: 30,
      benfordMinSample: 50,
      trapBandPercent: 5,
      duplicateAreaMin: 10,
      ghostNameMinLength: 7,
      summaryFlaggedMedium: 20,
      summaryFlaggedHigh: 50,
    },
    summary: {
      flaggedCount: 1,
      duplicateCount: 0,
      totalDuplicateAmount: '0.0000',
      weekendCount: 0,
      weekendAmount: '0.0000',
      rsfCount: 0,
      zScoreCount: 0,
      sequentialGroups: 0,
      ghostCount: 0,
      trapCount: 0,
      totalAtRisk: '1234.5670',
      overallRiskScore: 40,
      benfordConformity: 'acceptable',
      benford2DConformity: 'acceptable',
      approvalLimitRisk: false,
      topRiskAreas: [],
    },
    duplicates: { total: 0, pairs: [], groups: [], unavailable: null },
    benford1D: { totalTransactions: 1, digits: [], mad: 0, conformity: 'acceptable', message: '', byCurrency: [] },
    benford2D: { totalTransactions: 1, digits: [], anomalies: [], mad: 0, conformity: 'acceptable', byCurrency: [] },
    thresholdTrap: { total: 0, totalAmount: '0.0000', byTrap: [], items: [], unavailable: null },
    weekend: { total: 0, totalAmount: '0.0000', saturday: 0, sunday: 0, items: [] },
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
        amount: '1234.567',
        currency: 'USD',
        funcAmount: '1234.5670',
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

async function mount(data: SentinelData) {
  globalThis.__svRouter = { push() {}, refresh() {} }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(providers(<SentinelView data={data} />))
    await tick()
  })
  await tick()
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

async function clickButton(host: Element, match: (text: string) => boolean, name: string) {
  const btn = [...host.querySelectorAll('button')].find((b) => match(b.textContent ?? ''))
  assert.ok(btn, `${name} must exist`)
  await click(btn)
}

// The Scoring model panel is generated from the payload's rubric object —
// every section and row the loader scores with must reach the operator.
test('configuration renders the severity model from the payload', async () => {
  const { host, unmount } = await mount(fixture())
  try {
    await clickButton(host, (text) => text.startsWith('Config'), 'the configuration tab')
    const body = host.textContent ?? ''
    assert.ok(body.includes('Scoring model'), 'the scoring panel must render')
    for (const section of ['Duplicates', 'Weekend postings', 'Relative size', 'Sequential runs', 'Ghost vendors']) {
      assert.ok(body.includes(section), `the scoring panel must name ${section}`)
    }
    assert.ok(body.includes('Base score: 50'), 'the duplicate base points must render')
    assert.ok(body.includes('Shared reference: 95%'), 'the duplicate reference confidence must render')
    assert.ok(
      body.includes('Critical multi-document total (USD) or more: +20'),
      'the duplicate tier rule must resolve its catalog key, not a missing-key fallback',
    )
    assert.ok(!body.includes('scoring.dupValue'), 'no rule may name a catalog key that does not exist')
  } finally {
    await unmount()
  }
})

// A detector with no configuration refuses by name with the remedy —
// never a silent zero.
test('trap tab names the missing Flows configuration', async () => {
  const data = fixture()
  data.thresholdTrap.unavailable = 'No approval amount limits in Flows — add one, or tune the band in Sentinel → Configuration.'
  const { host, unmount } = await mount(data)
  try {
    await clickButton(host, (text) => text.startsWith('Benford'), 'the Benford tab')
    await clickButton(host, (text) => text.toLowerCase().includes('hreshold trap'), 'the threshold-trap sub-tab')
    assert.ok(
      (host.textContent ?? '').includes('No approval amount limits in Flows'),
      'the trap refusal and its remedy must reach the operator',
    )
  } finally {
    await unmount()
  }
})

test('duplicate tab names the missing floor', async () => {
  const data = fixture()
  data.duplicates.unavailable = 'Set the duplicate minimum in Sentinel → Configuration.'
  const { host, unmount } = await mount(data)
  try {
    await clickButton(host, (text) => text.startsWith('Detection'), 'the detection tab')
    await clickButton(host, (text) => text.includes('uplicate') && !text.startsWith('Detection'), 'the duplicates sub-tab')
    assert.ok(
      (host.textContent ?? '').includes('Set the duplicate minimum in Sentinel → Configuration.'),
      'the duplicate refusal and its remedy must reach the operator',
    )
  } finally {
    await unmount()
  }
})
