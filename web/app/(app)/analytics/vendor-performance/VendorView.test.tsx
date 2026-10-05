import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { VendorData } from '../../../../lib/analytics/vendor-data'
import { ANALYTICS_CONFIG } from '../../../../lib/analytics/config-spec'

// Vendor CSVs must carry exact spend and average-bill values: the export
// passes the ledger amounts straight through instead of rounding them.

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/analytics/vendor-performance', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
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

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { VendorView } = await import('./VendorView')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function fixture(): VendorData {
  return {
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    config: { ...ANALYTICS_CONFIG.vendorPerformance.defaults },
    rows: [
      {
        id: 'v-acme',
        name: 'Acme Supplies',
        spend: '9876.5430',
        priorSpend: '9000.0000',
        yoyPct: 0.097,
        sharePct: 0.42,
        bills: 80,
        avgBill: '123.4560',
        lastBill: '2026-07-28',
        recencyDays: 3,
        tier: 'strategic',
        paidBills: 78,
        undatedBills: 0,
        avgDaysToPay: 21,
        onTimePct: 0.95,
        latePct: 0.05,
        lateSpend: '100.0000',
        score: 82.4,
        grade: 'A',
        performance: 88,
        quadrant: 'strategic',
      },
    ],
    monthly: [],
    totals: {
      vendors: 1,
      spend: '9876.5430',
      priorSpend: '9000.0000',
      yoyPct: 0.097,
      bills: 80,
      avgBill: '123.4560',
      top5SharePct: 42,
      top10SharePct: 42,
      hhi: 0.2,
      hhiScaled: 2000,
      strategic: 1,
      onTimePct: 0.95,
      avgDaysToPay: 21,
      lateSpend: '100.0000',
      undatedBills: 0,
    },
    tierBreakdown: [{ tier: 'strategic', count: 1, spend: '9876.5430' }],
    gradeBreakdown: [{ grade: 'A', count: 1, spend: '9876.5430' }],
    quadrantBreakdown: [{ quadrant: 'strategic', count: 1, spend: '9876.5430' }],
  } as unknown as VendorData
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

test('vendor CSV exports retain spend and average bill decimals', async () => {
  let blob: Blob | undefined
  let downloadedFile = ''
  let clickedHref = ''
  const realCreateObjectURL = URL.createObjectURL
  const realRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = (value: Blob) => {
    blob = value
    return 'blob:vendor-export-test'
  }
  URL.revokeObjectURL = () => {}
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<VendorView data={fixture()} />))
      await tick()
    })
    await tick()
    const vendorsTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Vendors')
    assert.ok(vendorsTab, 'the vendors tab must exist')
    await click(vendorsTab)
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
      assert.ok(exportButton, 'the vendors table must offer a CSV export')
      await click(exportButton)
    } finally {
      document.createElement = realCreate
    }
    assert.ok(blob, 'clicking export must produce a download blob')
    const text = await blob!.text()
    assert.ok(text.includes('9876.543'), `spend must stay decimal, got:\n${text}`)
    assert.ok(text.includes('123.456'), `average bill must stay decimal, got:\n${text}`)
    assert.ok(!text.includes('9877'), `spend must not be rounded, got:\n${text}`)
    assert.ok(!text.includes(',123,'), `average bill must not be rounded, got:\n${text}`)
    assert.equal(downloadedFile, 'vendors-2026-08-28.csv')
    assert.equal(clickedHref, 'blob:vendor-export-test')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    URL.createObjectURL = realCreateObjectURL
    URL.revokeObjectURL = realRevokeObjectURL
  }
})

test('vendors without payment history read Unrated, never a neutral score', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    const data = fixture()
    data.rows.push({
      id: 'v-new',
      name: 'Brand New Co',
      spend: '500.0000',
      priorSpend: '0',
      yoyPct: null,
      sharePct: 0.05,
      bills: 2,
      avgBill: '250.0000',
      lastBill: '2026-07-20',
      recencyDays: 11,
      tier: 'tail',
      paidBills: 0,
      undatedBills: 0,
      avgDaysToPay: null,
      onTimePct: null,
      latePct: null,
      lateSpend: '0',
      score: 20,
      grade: 'D',
      performance: null,
      quadrant: 'unrated',
    })
    await act(async () => {
      root.render(providers(<VendorView data={data} />))
      await tick()
    })
    await tick()
    const scorecardTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Scorecard')
    assert.ok(scorecardTab, 'the scorecard tab must exist')
    await click(scorecardTab)
    assert.ok(
      host.textContent?.includes('Unrated'),
      `an unrated vendor must be named as Unrated, got:\n${host.textContent}`,
    )
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
