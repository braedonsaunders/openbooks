import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F-t06-002: the drawer's up-front currency refusal names the account and
// its allowed currency in the operator's language. The drawer serves the
// ap, ar, and banking namespaces, so the key must resolve in all three. A
// new user-visible string is a catalog key in ALL locales — never English
// pasted into a non-English catalog — pinned here through the real catalog
// files.
const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'messages')
const LOCALES = ['en', 'fr', 'es', 'de', 'ja', 'zh', 'pt-BR'] as const
const NAMESPACES = ['ap', 'ar', 'banking'] as const

const drawer = (locale: string, namespace: string): Record<string, unknown> => {
  const catalog = JSON.parse(
    readFileSync(join(messagesDir, locale, `${namespace}.json`), 'utf8'),
  ) as { drawer?: Record<string, unknown> }
  assert.ok(catalog.drawer, `${locale}/${namespace}.json must carry the drawer section`)
  return catalog.drawer
}

for (const namespace of NAMESPACES) {
  test(`drawer.currencyMismatch is translated in every locale (${namespace})`, () => {
    const en = drawer('en', namespace).currencyMismatch
    assert.equal(typeof en, 'string')
    for (const locale of LOCALES) {
      const message = drawer(locale, namespace).currencyMismatch
      assert.equal(typeof message, 'string', `${locale} must translate ${namespace}.drawer.currencyMismatch`)
      for (const param of ['{account}', '{allowed}', '{actual}']) {
        assert.ok(
          (message as string).includes(param),
          `${locale} ${namespace}.drawer.currencyMismatch must interpolate ${param}`,
        )
      }
    }
    for (const locale of LOCALES.slice(1)) {
      assert.notEqual(
        drawer(locale, namespace).currencyMismatch,
        en,
        `${locale} must not paste the English copy`,
      )
    }
  })
}
