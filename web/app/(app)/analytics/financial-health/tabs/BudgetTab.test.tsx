import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HealthData } from '../../../../../lib/analytics/health-data'

// Budget CSVs must carry exact money values, and a revenue shortfall must
// read "Under", never "Over" (F-t09-004) — with the tolerance disclosed.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/analytics/financial-health',
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

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../../components/business-date-provider')
const { BudgetTab } = await import('./BudgetTab')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

// One revenue line 123.96 short of a 10000.50 budget: status 'under',
// variance −123.96, variancePct −1.2%.
function shortfallData() {
  return {
    budget: {
      scenario: { id: 'fy26', name: 'FY26 Operating', fiscalYear: 2026, status: 'approved' },
      rows: [
        {
          accountId: 'a-rev',
          name: 'Services revenue',
          type: 'revenue',
          budget: 10000.5,
          actual: 9876.54,
          variance: -123.96,
          variancePct: -0.012396,
          favorable: false,
          status: 'under',
        },
      ],
      totals: { budget: 10000.5, actual: 9876.54, variance: -123.96 },
    },
  } as unknown as HealthData
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

test('budget CSV exports retain decimal money values', async () => {
  let blob: Blob | undefined
  let downloadedFile = ''
  const realCreateObjectURL = URL.createObjectURL
  const realRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = (value: Blob) => {
    blob = value
    return 'blob:budget-export-test'
  }
  URL.revokeObjectURL = () => {}
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<BudgetTab data={shortfallData()} />))
      await tick()
    })
    await tick()
    let clickedHref = ''
    const exportButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CSV'))
    assert.ok(exportButton, 'the budget table must offer a CSV export')
    // Route the download through the captured anchor: the export appends its
    // own anchor, so observe it via createElement instead.
    const realCreate = document.createElement.bind(document)
    let seen: HTMLAnchorElement | undefined
    document.createElement = ((tag: string, opts?: ElementCreationOptions) => {
      const el = realCreate(tag, opts)
      if (tag === 'a') {
        seen = el as HTMLAnchorElement
        seen.click = () => {
          clickedHref = seen!.href
          downloadedFile = seen!.download
        }
      }
      return el
    }) as typeof document.createElement
    try {
      await click(exportButton)
    } finally {
      document.createElement = realCreate
    }
    assert.ok(blob, 'clicking export must produce a download blob')
    assert.ok(seen, 'the export must go through an anchor download')
    const text = await blob!.text()
    assert.ok(text.includes('10000.5'), `budget must stay decimal, got:\n${text}`)
    assert.ok(text.includes('9876.54'), `actual must stay decimal, got:\n${text}`)
    assert.ok(text.includes('-123.96'), `variance must stay decimal, got:\n${text}`)
    assert.ok(!text.includes('10001'), `budget must not be rounded, got:\n${text}`)
    assert.ok(!text.includes('9877'), `actual must not be rounded, got:\n${text}`)
    assert.ok(!text.includes('-124,'), `variance must not be rounded, got:\n${text}`)
    assert.equal(downloadedFile, 'budget-vs-actual-2026-08-28.csv')
    assert.equal(clickedHref, 'blob:budget-export-test')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    URL.createObjectURL = realCreateObjectURL
    URL.revokeObjectURL = realRevokeObjectURL
  }
})

test('a revenue shortfall reads Under, never Over, with the tolerance disclosed', () => {
  const html = renderToStaticMarkup(providers(<BudgetTab data={shortfallData()} />))
  assert.match(html, />Under</, 'the shortfall pill must read Under')
  assert.match(html, /bg-orange-100/, 'the under status keeps its own hue')
  assert.match(html, /Over \(0\)/, 'no shortfall may inflate the overrun count')
  assert.match(html, /Under \(1\)/, 'the shortfall is counted as under')
  assert.match(
    html,
    /On Track: favorable or within ±10% of budget/,
    'the tolerance rule is stated next to the table',
  )
})

test('budget under-status and tolerance copy exist in every locale catalog', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh']) {
    const catalog = JSON.parse(
      readFileSync(new URL(`../../../../../messages/${locale}/analytics.json`, import.meta.url), 'utf8'),
    ) as { financialHealth?: { budget?: { status?: Record<string, unknown>; toleranceNote?: unknown } } }
    const status = catalog.financialHealth?.budget?.status
    assert.equal(typeof status?.under, 'string', `${locale} needs financialHealth.budget.status.under`)
    assert.ok(String(status?.under).trim(), `${locale} status.under must not be blank`)
    assert.equal(
      typeof catalog.financialHealth?.budget?.toleranceNote,
      'string',
      `${locale} needs financialHealth.budget.toleranceNote`,
    )
  }
})
