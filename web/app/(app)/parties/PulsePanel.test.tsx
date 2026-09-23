import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import crmMessages from '../../../messages/en/crm.json'
import commonMessages from '../../../messages/en/common.json'
import { MoneyProvider } from '@/components/money-provider'
import { PulsePanel } from './PulsePanel'
import type { CustomerPulseData } from '../../../lib/customer-pulse'

Object.assign(globalThis, { React })

const baseParty = {
  id: 'party-1',
  displayName: 'Acme Customer',
  email: 'ar@acme.test',
  phone: null,
  website: null,
  currency: 'CAD',
  subsidiaryName: 'Main Co',
}

const arSections = {
  aging: { current: '1000.0000', days1To30: '0.0000', days31To60: '0.0000', days61To90: '0.0000', days90Plus: '0.0000', totalOpen: '1000.0000', totalOverdue: '0.0000' },
  credit: { creditLimit: '10000.0000', openArBalance: '1000.0000', unbilledOrdersBalance: '0.0000', remainingCredit: '9000.0000', creditUtilizationPercent: 10 },
  paymentMetrics: { dso: 30, partyAvgDaysToPay: 28, orgAvgDaysToPay: 32, settlementsCount: 4 },
}

const crmSections = {
  pipeline: {
    totalOpportunities: 2, openOpportunities: 1, wonOpportunities: 1, lostOpportunities: 0,
    projectedPipeline: '5000.0000', weightedPipeline: '3000.0000', wonAmount: '4000.0000', winRatePercent: 100,
  },
}

function render(data: CustomerPulseData): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ 'crm': { pulse: crmMessages.pulse }, common: commonMessages }}
    >
      <MoneyProvider currency="CAD"><PulsePanel data={data} /></MoneyProvider>
    </NextIntlClientProvider>,
  )
}

/**
 * Omitted sections render a named "not available with your access" state —
 * never zeros. A CRM-only salesperson must not see AR balances; an AR-only
 * clerk must not see pipeline.
 */
test('pulse panel names withheld sections instead of rendering zeros', () => {
  const crmOnly: CustomerPulseData = {
    party: baseParty,
    sections: { ar: false, crm: true, projects: false },
    ...crmSections,
    timeline: [{
      id: 'a1', type: 'activity', title: 'discovery call',
      description: null, status: 'completed', timestamp: '2026-07-10',
    }],
  }
  const markup = render(crmOnly)
  assert.ok(markup.includes('Not available with your access.'))
  assert.ok(!markup.includes('1,000'), 'AR balance must not leak to a CRM-only caller')
  assert.ok(!markup.includes('10,000'), 'credit limit must not leak to a CRM-only caller')
  assert.ok(markup.includes('discovery call'))

  const arOnly: CustomerPulseData = {
    party: { ...baseParty, paymentTermsName: 'Net 30', isOnHold: false, holdReason: null, creditLimit: '10000.0000', hasCreditLimit: true },
    sections: { ar: true, crm: false, projects: false },
    ...arSections,
    timeline: [{
      id: 'd1', type: 'invoice', title: 'INV-1 (customer invoice)', description: null,
      amount: '1000.0000', currency: 'CAD', status: 'posted', timestamp: '2026-07-09', reference: 'INV-1',
    }],
  }
  const arMarkup = render(arOnly)
  assert.ok(arMarkup.includes('Not available with your access.'))
  assert.ok(!arMarkup.includes('5,000'), 'pipeline must not leak to an AR-only caller')
  assert.ok(arMarkup.includes('INV-1'))
})

test('pulse panel with full access shows every section and no restriction', () => {
  const full: CustomerPulseData = {
    party: { ...baseParty, paymentTermsName: 'Net 30', isOnHold: false, holdReason: null, creditLimit: '10000.0000', hasCreditLimit: true },
    sections: { ar: true, crm: true, projects: true },
    ...arSections,
    ...crmSections,
    projects: {
      enabled: true, totalCount: 1, activeCount: 1, totalContractValue: '20000.0000',
      totalBilled: '5000.0000', totalCost: '0.0000', grossProfit: '5000.0000', grossMarginPercent: 100,
    },
    timeline: [],
  }
  const markup = render(full)
  assert.ok(!markup.includes('Not available with your access.'))
  assert.ok(markup.includes('No recorded activities'))
})

test('pulse panel reports a withheld timeline instead of no activity', () => {
  const projectsOnly: CustomerPulseData = {
    party: baseParty,
    sections: { ar: false, crm: false, projects: true },
    projects: {
      enabled: true, totalCount: 1, activeCount: 1, totalContractValue: '20000.0000',
      totalBilled: '5000.0000', totalCost: '0.0000', grossProfit: '5000.0000', grossMarginPercent: 100,
    },
    timeline: [],
  }
  const markup = render(projectsOnly)
  assert.ok(markup.includes('Not available with your access.'))
  assert.ok(!markup.includes('No recorded activities'))
})
