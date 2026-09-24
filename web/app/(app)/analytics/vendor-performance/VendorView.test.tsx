import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { VendorData } from '../../../../lib/analytics/vendor-data'

// Vendor CSVs must carry exact spend and average-bill values: the export
// passes the ledger amounts straight through instead of rounding them.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/analytics/vendor-performance',
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
    if (specifier === '@openbooks/analytics/viz') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function InsightChart(){return null}export function InsightResultView(){return null}',
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
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { VendorView } = await import('./VendorView')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function fixture(): VendorData {
  return {
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    rows: [
      {
        id: 'v-acme',
        name: 'Acme Supplies',
        spend: 9876.543,
        priorSpend: 9000,
        yoyPct: 0.097,
        sharePct: 0.42,
        bills: 80,
        avgBill: 123.456,
        lastBill: '2026-07-28',
        recencyDays: 3,
        tier: 'strategic',
        paidBills: 78,
        avgDaysToPay: 21,
        onTimePct: 0.95,
        latePct: 0.05,
        lateSpend: 100,
        score: 82.4,
        grade: 'A',
        performance: 88,
        quadrant: 'strategic',
      },
    ],
    monthly: [],
    totals: {
      vendors: 1,
      spend: 9876.543,
      priorSpend: 9000,
      yoyPct: 0.097,
      bills: 80,
      avgBill: 123.456,
      top5SharePct: 42,
      top10SharePct: 42,
      hhi: 0.2,
      hhiScaled: 2000,
      strategic: 1,
      onTimePct: 0.95,
      avgDaysToPay: 21,
      lateSpend: 100,
    },
    tierBreakdown: [{ tier: 'strategic', count: 1, spend: 9876.543 }],
    gradeBreakdown: [{ grade: 'A', count: 1, spend: 9876.543 }],
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
