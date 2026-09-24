import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { SpendVelocityData } from '../../../../lib/analytics/spend-velocity-data'

// Spend account CSVs must carry exact ledger amounts: current, prior,
// two-back and projected pass through instead of being rounded.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/analytics/spend-velocity',
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
const { SpendVelocityView } = await import('./SpendVelocityView')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function fixture(): SpendVelocityData {
  return {
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    summary: {
      totalSpend: 5432.109,
      accountCount: 1,
      avgVelocity: 1.5,
      avgAcceleration: 0.2,
      acceleratingCount: 0,
      deceleratingCount: 0,
      highVelocityCount: 0,
      healthScore: 80,
      healthGrade: 'B',
      billsTotal: 0,
      expensesTotal: 0,
      billsVelocity: 0,
      savingsPotential: 0,
      totalAlerts: 0,
    },
    anomalies: { summary: { count: 0, criticalCount: 0 }, items: [] },
    boilingFrog: { summary: { count: 0, totalAnnualizedCreep: 0 }, accounts: [] },
    zombies: { summary: { count: 0, totalAnnualCost: 0 }, items: [] },
    fragmentation: { summary: { fragmentedCategories: 0, totalFragmentedSpend: 0 }, items: [] },
    concentration: { summary: { top1Share: 10, top5Share: 40 }, accounts: [] },
    commitmentCliff: { summary: { velocityGap: 0, status: 'healthy', poVelocity: 0 } },
    seasonal: { insights: [], patterns: [] },
    accountVelocity: [],
    monthlyTrends: [],
    insights: [],
    periodComparison: {
      summary: {
        currentTotal: 5432.109,
        priorTotal: 5000,
        twoBackTotal: 4800,
        projectedTotal: 6100.445,
        changePct: 8.6,
        twoBackLabel: 'May',
      },
      accounts: [
        {
          accountId: 'a-rent',
          accountName: 'Office rent',
          currentAmount: 5432.109,
          priorAmount: 5000.25,
          twoBackAmount: 4800.125,
          changePct: 8.6,
          projectedAmount: 6100.445,
          isNew: false,
          monthlyTrend: [],
          velocity: 2.5,
          acceleration: 0.3,
          trend: 'stable',
        },
      ],
    },
  } as unknown as SpendVelocityData
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

test('spend velocity CSV exports retain account amount decimals', async () => {
  let blob: Blob | undefined
  let downloadedFile = ''
  let clickedHref = ''
  const realCreateObjectURL = URL.createObjectURL
  const realRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = (value: Blob) => {
    blob = value
    return 'blob:spend-export-test'
  }
  URL.revokeObjectURL = () => {}
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<SpendVelocityView data={fixture()} />))
      await tick()
    })
    await tick()
    const accountsTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Accounts')
    assert.ok(accountsTab, 'the accounts tab must exist')
    await click(accountsTab)
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
      assert.ok(exportButton, 'the accounts table must offer a CSV export')
      await click(exportButton)
    } finally {
      document.createElement = realCreate
    }
    assert.ok(blob, 'clicking export must produce a download blob')
    const text = await blob!.text()
    assert.ok(text.includes('5432.109'), `current amount must stay decimal, got:\n${text}`)
    assert.ok(text.includes('5000.25'), `prior amount must stay decimal, got:\n${text}`)
    assert.ok(text.includes('6100.445'), `projected amount must stay decimal, got:\n${text}`)
    assert.ok(!text.includes('5432,'), `current amount must not be rounded, got:\n${text}`)
    assert.ok(!text.includes('6100,'), `projected amount must not be rounded, got:\n${text}`)
    assert.equal(downloadedFile, 'spend-accounts-2026-08-28.csv')
    assert.equal(clickedHref, 'blob:spend-export-test')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    URL.createObjectURL = realCreateObjectURL
    URL.revokeObjectURL = realRevokeObjectURL
  }
})
