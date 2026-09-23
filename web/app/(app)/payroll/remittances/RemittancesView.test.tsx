import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./RemittancesView.tsx', import.meta.url), 'utf8')

// Exercise the real client view: a refusal must never look like a zero balance.
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return {
      shortCircuit: true,
      url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}',
    }
    return next(specifier, context)
  },
})
const React = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('../../../../components/money-provider')
const { RemittancesView } = await import('./RemittancesView')
const messages = JSON.parse(readFileSync(new URL('../../../../messages/en/payroll.json', import.meta.url), 'utf8'))
import type { RemittanceGroup } from '../../../../../engine/src/payroll/remittance.ts'
Object.assign(globalThis, { React })

test('remittance bill payload follows edited dates while preserving unchanged range values', () => {
  assert.match(source, /const \[range, setRange\] = useState\(\{ from, to \}\)/)
  assert.match(source, /value=\{range\.from\}[\s\S]*?from: e\.target\.value/)
  assert.match(source, /value=\{range\.to\}[\s\S]*?to: e\.target\.value/)

  const payload = source.match(/body: JSON\.stringify\(\{([\s\S]*?)\n        \}\),/)?.[1]
  assert.ok(payload, 'create-bill must serialize a request payload')
  assert.match(payload, /from: range\.from/)
  assert.match(payload, /to: range\.to/)
  assert.doesNotMatch(payload, /^\s*from,\s*$/m)
  assert.doesNotMatch(payload, /^\s*to,\s*$/m)
})

test('refused remittance view renders an alert and date form, without an empty balance or bill action', () => {
  const message = 'Committed payroll has an unknown historical filing account.'
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en-CA" timeZone="UTC" messages={{ payroll: messages }}>
      <MoneyProvider currency="CAD">
        <RemittancesView groups={[]} from="2026-08-01" to="2026-08-31" canCreate={false} populationRefusal={message} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
  assert.ok(html.includes(message))
  assert.ok(html.includes('role="alert"'))
  assert.ok(html.includes('action="/payroll/remittances"'))
  assert.ok(html.includes('value="2026-08-01"'))
  assert.ok(html.includes('value="2026-08-31"'))
  assert.ok(!html.includes(messages.remittances.empty))
  assert.ok(!html.includes(messages.remittances.createBill))
})

test('a scheduled destination names its authority, due date, and rule; legacy groups show none', () => {
  const rqGroup: RemittanceGroup = {
    partyId: '11111111-1111-4111-8111-111111111111',
    partyName: 'Revenu Québec',
    filingAccount: { id: 'acct-1', accountNumber: '123456789RP0009', name: 'Quebec division', remitterType: 'accelerated_2' },
    hasUnknownFilingAccount: false,
    hasEntitylessAccruals: false,
    // This group is scheduled, so its due date comes from the schedule and
    // never from a regional calendar; stating null keeps that explicit.
    regionalCalendar: null,
    vendorKeys: ['rqRemittancePartyId'],
    schedule: {
      vendorSettingsKey: 'rqRemittancePartyId',
      authority: 'Revenu Québec',
      frequency: 'monthly',
      frequencySource: 'default',
      dueDate: '2026-08-17',
      rule: 'Revenu Québec monthly remitter (average monthly remittance $3,000 to under $25,000) — the 15th of the month following the month of the pay date',
    },
    provinces: ['QC'],
    components: [
      {
        componentId: 'c1', code: 'QPIP', name: 'QPIP', kind: 'deduction',
        systemKey: 'qpip', liabilityAccountId: 'liab-1', accountLabel: '2320 · RQ payable',
        amount: '400.0000', currency: 'CAD',
      },
    ],
    total: '400.0000',
    currency: 'CAD',
    translated: false,
    slices: [],
    grossPayroll: '2000.0000',
    employeeCount: 1,
    existingBills: [],
  }
  const legacyGroup: RemittanceGroup = {
    ...rqGroup,
    partyId: '22222222-2222-4222-8222-222222222222',
    partyName: 'Receiver General',
    vendorKeys: ['craRemittancePartyId'],
    schedule: null,
  }
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en-CA" timeZone="UTC" messages={{ payroll: messages }}>
      <MoneyProvider currency="CAD">
        <RemittancesView groups={[rqGroup, legacyGroup]} from="2026-07-01" to="2026-07-31" canCreate={false} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
  // The RQ card carries its destination schedule; the CRA card — dated by the
  // legacy function at bill creation — shows no schedule line.
  assert.ok(html.includes('Revenu Québec'))
  assert.ok(html.includes('2026-08-17'))
  assert.ok(html.includes('Revenu Québec monthly remitter'))
  assert.equal(html.split('Due ').length - 1, 1)
})

test('a EUR-only scope under a GBP org renders euros, never pounds', () => {
  const eurGroup: RemittanceGroup = {
    partyId: '33333333-3333-4333-8333-333333333333',
    partyName: 'Receiver General',
    filingAccount: { id: null, accountNumber: null, name: null, remitterType: null },
    hasUnknownFilingAccount: false,
    hasEntitylessAccruals: false,
    regionalCalendar: null,
    vendorKeys: [],
    schedule: null,
    provinces: ['LON'],
    components: [
      {
        componentId: 'c1', code: 'ITAX', name: 'Income tax', kind: 'deduction',
        systemKey: 'income_tax', liabilityAccountId: 'liab-1', accountLabel: '2000 · Payroll liabilities',
        amount: '12250.00', currency: 'EUR',
      },
    ],
    total: '12250.00',
    currency: 'EUR',
    translated: false,
    slices: [],
    grossPayroll: '12250.00',
    employeeCount: 1,
    existingBills: [],
  }
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en-GB" timeZone="UTC" messages={{ payroll: messages }}>
      <MoneyProvider currency="GBP">
        <RemittancesView groups={[eurGroup]} from="2026-09-01" to="2026-09-30" canCreate={false} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
  // The stated currency labels the card and formats every amount: €12,250.00
  // is a euro figure an operator can act on, not £12,250 misread as pounds.
  assert.ok(html.includes('EUR'), 'the card names its stated currency')
  assert.ok(html.includes('€12,250.00'), `euro amounts render as euros: ${html}`)
  assert.ok(!html.includes('£12,250.00'), 'no amount renders as pounds')
})

test('a translated scope names the presentation currency it was translated into', () => {
  const translatedGroup: RemittanceGroup = {
    partyId: '44444444-4444-4444-8444-444444444444',
    partyName: 'Receiver General',
    filingAccount: { id: null, accountNumber: null, name: null, remitterType: null },
    hasUnknownFilingAccount: false,
    hasEntitylessAccruals: false,
    regionalCalendar: null,
    vendorKeys: [],
    schedule: null,
    provinces: ['LON', 'DUB'],
    components: [
      {
        componentId: 'c1', code: 'ITAX', name: 'Income tax', kind: 'deduction',
        systemKey: 'income_tax', liabilityAccountId: 'liab-1', accountLabel: '2000 · Payroll liabilities',
        amount: '21495.83', currency: 'GBP',
      },
    ],
    total: '21495.83',
    currency: 'GBP',
    translated: true,
    slices: [],
    grossPayroll: '21495.83',
    employeeCount: 2,
    existingBills: [],
  }
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en-GB" timeZone="UTC" messages={{ payroll: messages }}>
      <MoneyProvider currency="GBP">
        <RemittancesView groups={[translatedGroup]} from="2026-09-01" to="2026-09-30" canCreate={false} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
  assert.ok(html.includes('£21,495.83'))
  assert.ok(html.includes('Translated to GBP'), 'the translated figure is labelled as translated')
})
