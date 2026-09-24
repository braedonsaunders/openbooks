import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { CustomerData, CustomerRow } from '../../../../lib/analytics/customer-data'

// Customer health CSVs keep full revenue/CLV precision, and the customer
// drill carries the waterfall-signed invoiced→recognized bridge.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/analytics/customer-intelligence',
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__cvRouter}export function usePathname(){return \'/analytics/customer-intelligence\'}export function useSearchParams(){return new URLSearchParams()}',
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
  var __cvRouter: { push(url: string): void; refresh(): void } | undefined
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
const { CustomerView } = await import('./CustomerView')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function row(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'c-acme',
    name: 'Acme Corp',
    revenue: 845,
    priorRevenue: 800,
    invoicedRevenue: 900,
    recon: { tax: 20, credits: 5, timingDeferred: 30, timingRecognized: 10, voids: 5, other: 5 },
    yoyPct: 5.6,
    invoices: 12,
    avgInvoice: 75,
    firstInvoice: '2025-01-04',
    lastInvoice: '2026-07-20',
    recencyDays: 8,
    tenureDays: 400,
    rfm: { r: 5, f: 4, m: 5, score: 90, code: '555' },
    segment: 'champions',
    annualValue: 900,
    clv: 432.109,
    retentionFactor: 92,
    tier: 'gold',
    clvRank: 1,
    churnScore: 8,
    churnLevel: 'low',
    churnFactors: [],
    retentionProbability: 92,
    avgDaysBetween: 30,
    frictionPoints: 0,
    frictionLevel: 'low',
    creditCount: 0,
    creditValue: 0,
    returnRate: 0,
    avgOrderCycle: 30,
    daysOverdue: 0,
    urgency: 'on-track',
    paymentScore: 95,
    paymentRating: 'excellent',
    avgDaysToPay: 12,
    overdueCount: 0,
    paymentRate: 100,
    sharePct: 42,
    concentrationRisk: 'medium',
    grossProfit: 400,
    marginPct: 47.3,
    isFakeChampion: false,
    jobs: 3,
    healthScore: 85,
    healthGrade: 'A',
    recommendation: 'maintain',
    recommendationDetail: '',
    scoreBreakdown: { recency: 20, frequency: 20, monetary: 20, payment: 20, frictionPenalty: 0 },
    ...overrides,
  } as CustomerRow
}

function dataWith(rows: CustomerRow[]): CustomerData {
  return {
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    rows,
    intelligence: { score: 80, label: 'Strong', grade: 'A' },
    kpis: {
      totalCustomers: rows.length,
      totalRevenue: 845,
      totalInvoiced: 900,
      avgCustomerValue: 845,
      projectedClv: 432.109,
      avgClv: 432.109,
      champions: 1,
      atRiskCount: 0,
      atRiskRevenue: 0,
      retentionRate: 92,
      paymentRate: 100,
      avgDaysToPay: 12,
      top10PctShare: 42,
      hhiScaled: 2000,
      hhiLevel: 'moderate',
      topCustomerShare: 42,
      monthlyGrowth: 1.2,
      yoyGrowth: 5.6,
      newCustomers: 0,
      overdueInvoices: 0,
      overdueOrders: 0,
      criticalFriction: 0,
      highFriction: 0,
      fakeChampions: 0,
    },
    segments: [
      { segment: 'champions', count: 1, percentage: 100, totalRevenue: 845, avgRevenue: 845, totalInvoiced: 900 },
    ],
    tierBreakdown: [{ tier: 'gold', count: 1, revenue: 845, invoiced: 900, threshold: 0 }],
    growth: [],
    insights: [],
  } as unknown as CustomerData
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

function stubDownloads() {
  let blob: Blob | undefined
  let downloadedFile = ''
  let clickedHref = ''
  const realCreateObjectURL = URL.createObjectURL
  const realRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = (value: Blob) => {
    blob = value
    return 'blob:customer-export-test'
  }
  URL.revokeObjectURL = () => {}
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
  return {
    restore() {
      document.createElement = realCreate
      URL.createObjectURL = realCreateObjectURL
      URL.revokeObjectURL = realRevokeObjectURL
    },
    async text() {
      assert.ok(blob, 'clicking export must produce a download blob')
      return blob!.text()
    },
    downloadedFile: () => downloadedFile,
    clickedHref: () => clickedHref,
  }
}

test('customer health CSV exports retain revenue and CLV decimals', async () => {
  globalThis.__cvRouter = { push() {}, refresh() {} }
  const data = dataWith([
    row({ revenue: 1845.756, invoicedRevenue: 1900.125, clv: 432.109 }),
  ])
  const downloads = stubDownloads()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<CustomerView data={data} profitability={{} as never} />))
      await tick()
    })
    await tick()
    const healthTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Health Scores')
    assert.ok(healthTab, 'the health tab must exist')
    await click(healthTab)
    const exportButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CSV'))
    assert.ok(exportButton, 'the health table must offer a CSV export')
    await click(exportButton)
    const text = await downloads.text()
    assert.ok(text.includes('1845.756'), `revenue must stay decimal, got:\n${text}`)
    assert.ok(text.includes('1900.125'), `invoiced revenue must stay decimal, got:\n${text}`)
    assert.ok(text.includes('432.109'), `CLV must stay decimal, got:\n${text}`)
    assert.ok(!text.includes(',1846,'), `revenue must not be rounded, got:\n${text}`)
    assert.ok(!text.includes(',432,'), `CLV must not be rounded, got:\n${text}`)
    assert.equal(downloads.downloadedFile(), 'customer-health-2026-08-28.csv')
    assert.equal(downloads.clickedHref(), 'blob:customer-export-test')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    downloads.restore()
  }
})

test('the customer drill carries the waterfall-signed recon bridge', async () => {
  globalThis.__cvRouter = { push() {}, refresh() {} }
  // Invoiced 900 − tax 20 − credits 5 − deferred 30 + recognized 10 −
  // voids 5 − other 5 = recognized 845.
  const data = dataWith([row({ revenue: 845, invoicedRevenue: 900 })])
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({
      mode: 'party',
      total: '845.00',
      count: 1,
      entries: [
        {
          date: '2026-07-05',
          entryId: 'e1',
          docId: null,
          docKind: 'customer_invoice',
          docNumber: 'INV-1',
          label: 'Acme Corp',
          memo: '',
          amount: '845.00',
        },
      ],
      monthly: [],
      breakdown: [],
    })) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<CustomerView data={data} profitability={{} as never} />))
      await tick()
    })
    await tick()
    const healthTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Health Scores')
    assert.ok(healthTab, 'the health tab must exist')
    await click(healthTab)
    const customerRow = [...host.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('Acme Corp'),
    )
    assert.ok(customerRow, 'the customer row must render')
    await click(customerRow)
    // The drill drawer portals to document.body, outside the mount host.
    const text = document.body.textContent ?? ''
    // Waterfall-signed legs: deferrals subtract from invoiced, recognition adds back.
    for (const leg of ['−$20', '−$5', '−$30', '+$10']) {
      assert.ok(text.includes(leg), `the bridge must show ${leg}, got:\n${text}`)
    }
    assert.ok(text.includes('$900'), `the bridge must start from invoiced $900, got:\n${text}`)
    assert.ok(text.includes('$845'), `the bridge must land on recognized $845, got:\n${text}`)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    globalThis.fetch = priorFetch
  }
})
