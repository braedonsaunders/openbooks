import type { SpendVelocityData } from '../../../../lib/analytics/spend-velocity-data'
import { ANALYTICS_CONFIG } from '../../../../lib/analytics/config-spec'
import { SPEND_VELOCITY_SEVERITY_MODEL } from '../../../../lib/analytics/spend-velocity-data'

/**
 * Shared fixtures for the Spend Velocity view tests (outside any *.test.*
 * file so the suites share one copy). en-USD rendering; the loader fills
 * every figure below with exact decimals in a real request.
 */
export function spendVelocityFixture(): SpendVelocityData {
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
      unconfiguredDetectors: ['fragmentation', 'cliff'],
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

/** Fixture with live frog and concentration alerts for the detectors tab. */
export function alertFixture(): SpendVelocityData {
  const data = spendVelocityFixture()
  data.boilingFrog.accounts = [
    { accountId: 'a-creep', accountName: 'Creeping SaaS', monotonicRatio: 80, avgMonthlyIncrease: 2.5, totalCreep: 25, startAmount: '100.0000', endAmount: '125.0000', monthCount: 10, annualizedCreep: '30.0000', monthlyAmounts: [], severity: 'critical' },
  ]
  data.concentration.accounts = [
    { id: 'a-big', name: 'Big Vendor Acct', entityType: 'account', totalSpend: '5000.0000', totalBills: '0', totalExpenses: '0', totalOther: '0', billPct: 0, expensePct: 0, transactionCount: 3, monthCount: 3, velocity: 30, acceleration: 5, trend: 'accelerating', latestSpend: '0', previousSpend: '0', avgMonthlySpend: '0', monthlyAmounts: [], monthLabels: [], spendShare: 35.5 },
  ]
  return data
}
