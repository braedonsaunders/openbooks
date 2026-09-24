import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const messagesDir = join(dir, '..', '..', '..', '..', 'messages')
const locales = ['de', 'en', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, 'admin.json'), 'utf8'))

function at(locale: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      locale,
    )
}

const keys = [
  'setup.redirectNotice.title',
  'setup.redirectNotice.settingsBody',
  'setup.redirectNotice.indexBody',
  'setup.redirectNotice.providersBody',
  'setup.redirectNotice.entityBody',
  'setup.wizard.skipped',
] as const

// Every top-level await settles BEFORE the first test() registers (see
// scripts/test-registration-order.test.mjs): the notice renders the movedFrom
// source's sentence and nothing otherwise — real component, scripted search
// params, real en catalog.
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        format: 'module',
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export function useSearchParams(){return{get(){return globalThis.__redirectNoticeSearch}}}',
          ),
      }
    }
    return next(specifier, context)
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { SetupRedirectNotice } = await import('./RedirectNotice')

// UX-17: the redirect notice and the Skip toast must read natively
// everywhere — a missing key renders the raw path mid-navigation.
for (const locale of locales) {
  test(`setup redirect copy exists in ${locale}`, () => {
    for (const key of keys) {
      const value = at(catalog(locale), key)
      assert.equal(typeof value, 'string', `${locale} ${key} must exist`)
      assert.ok((value as string).trim().length > 0, `${locale} ${key} must not be empty`)
    }
  })
}

for (const locale of locales.filter((candidate) => candidate !== 'en')) {
  test(`setup redirect copy is translated in ${locale}`, () => {
    for (const key of keys) {
      assert.notEqual(
        at(catalog(locale), key),
        at(catalog('en'), key),
        `${locale} ${key} must not be the English fallback`,
      )
    }
  })
}

function renderNotice(movedFrom: string | null): string {
  ;(globalThis as Record<string, unknown>).__redirectNoticeSearch = movedFrom
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SetupRedirectNotice />
    </NextIntlClientProvider>,
  )
}

test('each alias source renders its own reason', () => {
  assert.match(renderNotice('settings'), /\/admin\/settings now lives here/)
  assert.match(renderNotice('setup-index'), /go-live checklist/)
  assert.match(renderNotice('payment-providers'), /Online payments/)
  assert.match(renderNotice('setup-entity'), /moved to its module/)
})

test('no source renders no notice', () => {
  assert.equal(renderNotice(null), '')
  assert.equal(renderNotice('bogus'), '')
})
