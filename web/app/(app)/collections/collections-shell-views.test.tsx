import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../../../messages/en/index.ts'
import { MoneyProvider } from '../../../components/money-provider.tsx'

const { stubModules } = await import('../../../testing/stub-modules')
stubModules({
  navigation: true,
  intl: true,
  authz: true,
  features: true,
  extra: {
    'next/link':
      `export default function Link(p){return globalThis.React.createElement('a',{href:p.href,'aria-current':p['aria-current'],className:p.className},p.children)}`,
    'server-only': `export {}`,
    '@openbooks/engine/src/platform/db.ts':
      `export const db = { execute: async () => ({ rows: [] }) }`,
    '@openbooks/engine/payments/autopay':
      `export async function findCardsExpiringSoon(){return []}` +
      `export async function getRecoveryMetrics(){return {}}` +
      `export const MISSING_COLLECTION_POLICY = 'missing_collection_policy'`,
    '@openbooks/engine/platform/civil-date':
      `export function addCalendarDays(day){return day}`,
    '@openbooks/engine/platform/business-date':
      `export async function businessToday(){return '2026-10-01'}`,
    '../../../lib/custom-reports':
      `export async function builtInReportDefinitionId(){return null}`,
  },
})
const { CollectionsShell } = await import('./sections.tsx')
const { RecoveryDashboard } = await import('./RecoveryDashboard.tsx')
const { collectionsSpec } = await import('./view.ts')

Object.assign(globalThis, { React })
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tabs = [
  { href: '/collections?view=recovery', label: 'Recovery', active: true, count: 2 },
  { href: '/collections?view=attempts', label: 'Attempts', active: false },
  { href: '/collections?view=policies', label: 'Policies', active: false },
]

function render(initialView: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <CollectionsShell
          title="Collections"
          description="Collect receivables and manage billing."
          tabs={initialView === 'policies' ? tabs.map((tab) => ({ ...tab, active: tab.href.includes('policies') })) : tabs}
          initialView={initialView}
          autopayOn
          worklistHref={null}
          worklistLabel="Open the collections worklist"
          subscriptionsEnabled={false}
          advancedSubscriptionsEnabled={false}
          customers={[]}
          incomeAccounts={[]}
        />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
}

/**
 * Recovery and attempts own their page views: the shell renders its header
 * and tab strip there, never an operational panel beside the server block.
 */
test('the shell renders only its tab strip on the recovery view', () => {
  const html = render('recovery')
  assert.match(html, /view=recovery/)
  assert.match(html, /aria-current="page"/)
  assert.doesNotMatch(html, /Policy name/)
  assert.doesNotMatch(html, /Loading/)
})

test('the shell renders only its tab strip on the attempts view', () => {
  const html = render('attempts')
  assert.match(html, /view=attempts/)
  assert.doesNotMatch(html, /Policy name/)
  assert.doesNotMatch(html, /Loading/)
})

test('the shell still renders its policies panel with tabs present', () => {
  const html = render('policies')
  assert.match(html, /Policy name/)
})

function recoveryShellData() {
  return {
    title: 'Collections',
    description: 'Collect receivables and manage billing.',
    worklistHref: null,
    worklistLabel: 'Open the collections worklist',
    policyNotice: null,
    subscriptionsEnabled: false,
    advancedSubscriptionsEnabled: false,
    customers: [],
    incomeAccounts: [],
    autopayOn: true,
    recovery: null,
    tabs,
    activeView: 'recovery',
    onRecovery: true,
    onAttempts: false,
    currentParams: {},
    attemptDrawer: null,
    attemptsEmptyTitle: 'No attempts',
    attemptsEmptyDescription: 'Nothing attempted yet.',
  }
}

/**
 * The page header (inside the shell) composes before the selected body: the
 * framework renders spec blocks in order, so the shell block must lead and
 * the recovery and attempts blocks must stay gated behind their views.
 */
test('the spec composes the shell chrome first, then one selected body', () => {
  const spec = collectionsSpec(recoveryShellData())
  const body = (spec as unknown as { body: { widget?: string; when?: unknown }[] }).body
  assert.deepEqual(
    body.map((block) => block.widget),
    ['collections-shell', 'recovery-dashboard', 'entity-list-view'],
  )
  assert.equal(body[0]?.when, undefined, 'the shell chrome renders on every view')
  assert.ok(body[1]?.when, 'the dashboard renders only on its view')
  assert.ok(body[2]?.when, 'the attempts list renders only on its view')
})

/**
 * Rendered proof of the order above: the shell's header and tab strip come
 * out before the recovery body when the blocks compose in spec order.
 */
test('the rendered header precedes the recovery body', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <CollectionsShell
          title="Collections"
          description="Collect receivables and manage billing."
          tabs={tabs}
          initialView="recovery"
          autopayOn
          worklistHref={null}
          worklistLabel="Open the collections worklist"
          subscriptionsEnabled={false}
          advancedSubscriptionsEnabled={false}
          customers={[]}
          incomeAccounts={[]}
        />
        <RecoveryDashboard
          data={{
            window: { from: '2026-07-01', to: '2026-10-01' },
            recoveryReportId: 'report-recovery-1',
            canRunReport: true,
            metrics: {
              attempts: 0,
              invoicesWithFailures: 0,
              recoveredInvoices: 0,
              recoveredAmount: '0.00',
              recoveredByCurrency: [],
              recoveryRate: null,
              churnPrevented: 0,
              awaitingAuthentication: 0,
              byDeclineClass: [],
              byProvider: [],
            },
            awaitingAuth: [],
            expiring: [],
            hardStuck: [],
          }}
          notice={null}
        />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
  assert.ok(html.indexOf('Collections') < html.indexOf('Needs attention'), 'the header renders before the recovery body')
  assert.doesNotMatch(html, /Policy name/)
})
