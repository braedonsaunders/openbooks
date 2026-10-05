import type { VendorData } from '../../../../lib/analytics/vendor-data'
import { ANALYTICS_CONFIG } from '../../../../lib/analytics/config-spec'

/**
 * Shared fixtures for the Vendor Performance view tests (outside any
 * *.test.* file so the suites share one copy).
 */
export function vendorFixture(): VendorData {
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
        unratedReason: null,
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
      top5SharePct: 0.42,
      top10SharePct: 0.42,
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

/** One unrated row: no settled bills at all, or settled bills with no dates. */
export function unratedRow(id: string, name: string, reason: 'no-payments' | 'undated', paidBills: number): VendorData['rows'][number] {
  return {
    id, name, spend: '500.0000', priorSpend: '0', yoyPct: null, sharePct: 0.05, bills: 2,
    avgBill: '250.0000', lastBill: '2026-07-20', recencyDays: 11, tier: 'tail',
    paidBills, undatedBills: paidBills, avgDaysToPay: paidBills ? 9 : null,
    onTimePct: null, latePct: null, lateSpend: '0', score: 20, grade: 'D',
    performance: null, quadrant: 'unrated', unratedReason: reason,
  }
}
