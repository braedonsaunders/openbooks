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

test.after(() => hooks.deregister())
