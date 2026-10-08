import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { stubModules } from '../../testing/stub-modules'

stubModules({ navigation: { pathname: '/analytics/cashflow' }, intl: false, authz: false, features: false })
const imports: string[] = []
const hooks = registerHooks({ resolve(specifier, context, next) {
  // The App Router bundler resolves this alias to its Suspense implementation.
  if (specifier === 'next/dynamic') return next('next/dist/shared/lib/app-dynamic.js', context)
  if (context.parentURL?.endsWith('/viewspec/native-widgets.client.tsx')) imports.push(specifier)
  return next(specifier, context)
} })
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToReadableStream } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { default: catalog } = await import('../../messages/en')
const native = await import('./native-widgets.client')
imports.length = 0

test('native widget implementations load only when placed and retain their server-rendered controls', async () => {
  assert.equal(imports.length, 0)
  const messages = { ...catalog, analytics: { ...catalog.analytics, cashflow: { ...catalog.analytics.cashflow, horizon: { label: 'Forecast horizon', aria: 'Forecast horizon', weeks: '{count} weeks' } } } }
  const stream = await renderToReadableStream(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><native.HorizonControl value={19} /></NextIntlClientProvider>)
  await stream.allReady
  const html = await new Response(stream).text()
  assert.match(html, /Forecast horizon/)
  assert.match(html, /19 weeks/)
  assert.deepEqual(imports, ['../../app/(app)/analytics/cashflow/HorizonControl'])
  assert.ok(!imports.some(path => /RunWizard|ProjectDrawer|PropertyManagement/.test(path)))
})

test('bank feed panels render empty and populated states in the viewer formatting context', async () => {
  const { mapBankFeedRows } = await import('../../app/(app)/banking/imports/feed-rows')
  const props = { title: 'Bank feed connections', manageLabel: 'Manage feeds', emptyMessage: 'No live connections', lastSyncLabel: 'Last sync', lastAttemptLabel: 'Last attempt', neverLabel: 'Never' }
  const render = async (feeds: ReturnType<typeof mapBankFeedRows>) => {
    const stream = await renderToReadableStream(<NextIntlClientProvider locale="en" timeZone="America/Vancouver" messages={catalog}><native.BankFeedPanel {...props} feeds={feeds} /></NextIntlClientProvider>)
    await stream.allReady
    return new Response(stream).text()
  }
  assert.match(await render([]), /No live connections/)
  const html = await render(mapBankFeedRows([
    { name: 'Operating feed', provider: 'plaid', status: 'connected', last_sync_at: '2026-10-08T00:30:00Z', last_attempt_at: null, last_error: null, is_active: true, account_number: '1000', account_name: 'Operating bank' },
    { name: 'Paused feed', provider: 'other', status: 'unexpected', last_sync_at: null, last_attempt_at: '2026-10-08T00:30:00Z', last_error: 'Connection requires renewal', is_active: false, account_number: null, account_name: 'Secondary bank' },
  ]))
  for (const value of ['Operating feed', 'Operating bank', 'Plaid', 'Connected', 'Oct 7, 2026', 'Paused feed', 'Other provider', 'Unknown status', 'paused', 'Never', 'Last attempt', 'Connection requires renewal']) assert.ok(html.includes(value), value)
  assert.ok(!html.includes('Oct 8, 2026'), 'dates use the organization time zone')
  assert.match(html, /\/admin\/setup\/bank-feeds/)
})

test.after(() => hooks.deregister())
