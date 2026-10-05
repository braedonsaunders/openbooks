import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { SpendVelocityData } from '../../../../lib/analytics/spend-velocity-data'
import { ANALYTICS_CONFIG } from '../../../../lib/analytics/config-spec'
import { SPEND_VELOCITY_SEVERITY_MODEL } from '../../../../lib/analytics/spend-velocity-data'

// Spend account CSVs must carry exact ledger amounts: current, prior,
// two-back and projected pass through instead of being rounded.

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/analytics/spend-velocity', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/analytics/viz') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function InsightChart(){return null}export function InsightResultView(){return null}',
      }
    }
    // The configuration tab hosts the shared threshold editor, which reads
    // the Next app router: outside a mounted router it gets a no-op stub, so
    // the tab's read-only rubric panel stays testable here.
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return{refresh(){},push(){},replace(){},prefetch(){},back(){},forward(){}}}export function usePathname(){return"/"}export function useSearchParams(){return new URLSearchParams()}',
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
const { SpendVelocityView } = await import('./SpendVelocityView')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function fixture(): SpendVelocityData {
  return {
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    config: { ...ANALYTICS_CONFIG.spendVelocity.defaults },
    severityModel: SPEND_VELOCITY_SEVERITY_MODEL,
    summary: {
      totalSpend: '5432.1090',
      accountCount: 1,
      avgVelocity: 1.5,
      avgAcceleration: 0.2,
      acceleratingCount: 0,
      deceleratingCount: 0,
      highVelocityCount: 0,
      healthScore: 80,
      healthGrade: 'B',
      billsTotal: '0',
      expensesTotal: '0',
      billsVelocity: 0,
      savingsPotential: '0',
      totalAlerts: 0,
    },
    anomalies: { summary: { count: 0, criticalCount: 0 }, items: [] },
    boilingFrog: { summary: { count: 0, totalAnnualizedCreep: '0' }, accounts: [] },
    zombies: { summary: { count: 0, totalAnnualCost: '0' }, subscriptions: [] },
    fragmentation: { summary: { fragmentedCategories: 0, totalFragmentedSpend: '0', configured: false, reason: 'Set the fragmentation size cap in Spend Velocity → Configuration' }, categories: [] },
    concentration: { summary: { top1Share: 10, top5Share: 40 }, accounts: [] },
    shadowIT: { available: false, reason: 'Expense lines carry no payee vendor' },
    revenue: { hasData: false, totalRevenue: '0', opexRatio: 0 },
    commitmentCliff: { summary: { velocityGap: null, status: 'healthy', poVelocity: null, soVelocity: null, ratio: 0, monthsToCliff: null, totalPO: '0', totalSO: '0', configured: false, reason: 'Set the minimum base in Spend Velocity → Configuration' }, months: [] },
    seasonal: { insights: [], patterns: [] },
    accountVelocity: [],
    monthlyTrends: [],
    insights: [],
    periodComparison: {
      summary: {
        currentTotal: '5432.1090',
        priorTotal: '5000.0000',
        twoBackTotal: '4800.0000',
        projectedTotal: '6100.4450',
        changePct: 8.6,
        twoBackLabel: 'May',
      },
      accounts: [
        {
          accountId: 'a-rent',
          accountName: 'Office rent',
          currentAmount: '5432.1090',
          priorAmount: '5000.2500',
          twoBackAmount: '4800.1250',
          changePct: 8.6,
          projectedAmount: '6100.4450',
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

test('an unconfigured cliff names its remedy instead of scoring without a floor', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<SpendVelocityView data={fixture()} />))
      await tick()
    })
    await tick()
    const detectorsTab = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Detectors'))
    assert.ok(detectorsTab, 'the detectors tab must exist')
    await click(detectorsTab)
    assert.ok(
      host.textContent?.includes('Set the minimum base in Spend Velocity → Configuration'),
      `the cliff tile must name its remedy, got:\n${host.textContent}`,
    )
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('the configuration tab renders the fixed scoring rubric read-only', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<SpendVelocityView data={fixture()} />))
      await tick()
    })
    await tick()
    const configTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Configuration')
    assert.ok(configTab, 'the configuration tab must exist')
    await click(configTab)
    assert.ok(
      host.textContent?.includes('Scoring model'),
      `the rubric panel must render, got:\n${host.textContent}`,
    )
    assert.ok(
      host.textContent?.includes('Deduction cap'),
      `the rubric rows must name their weights, got:\n${host.textContent}`,
    )
    assert.ok(
      host.textContent?.includes('(<10%)'),
      `the frog note must show the configured step cap, got:\n${host.textContent}`,
    )
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('detector details never double the percent sign and name trends in words', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    const data = fixture()
    data.boilingFrog.accounts = [
      {
        accountId: 'a-creep', accountName: 'Creeping SaaS', monotonicRatio: 80, avgMonthlyIncrease: 2.5,
        totalCreep: 25, startAmount: '100.0000', endAmount: '125.0000', monthCount: 10,
        annualizedCreep: '30.0000', monthlyAmounts: [], severity: 'critical',
      },
    ]
    data.concentration.accounts = [
      {
        id: 'a-big', name: 'Big Vendor Acct', entityType: 'account', totalSpend: '5000.0000',
        totalBills: '0', totalExpenses: '0', totalOther: '0', billPct: 0, expensePct: 0,
        transactionCount: 3, monthCount: 3, velocity: 30, acceleration: 5, trend: 'accelerating',
        latestSpend: '0', previousSpend: '0', avgMonthlySpend: '0', monthlyAmounts: [], monthLabels: [],
        spendShare: 35.5,
      },
    ]
    await act(async () => {
      root.render(providers(<SpendVelocityView data={data} />))
      await tick()
    })
    await tick()
    const detectorsTab = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Detectors'))
    assert.ok(detectorsTab, 'the detectors tab must exist')
    await click(detectorsTab)
    assert.ok(
      !host.textContent?.includes('%%'),
      `no detail may double the percent sign, got:\n${host.textContent}`,
    )
    assert.ok(
      host.textContent?.includes('Accelerating'),
      `the concentration trend must read in words, got:\n${host.textContent}`,
    )
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('an unconfigured fragmentation detector names its remedy instead of scoring', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(providers(<SpendVelocityView data={fixture()} />))
      await tick()
    })
    await tick()
    const detectorsTab = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Detectors'))
    assert.ok(detectorsTab, 'the detectors tab must exist')
    await click(detectorsTab)
    assert.ok(
      host.textContent?.includes('Set the fragmentation size cap in Spend Velocity → Configuration'),
      `the fragmentation tile must name its remedy, got:\n${host.textContent}`,
    )
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
