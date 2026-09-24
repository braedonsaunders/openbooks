import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F-t06-002: the drawer's up-front currency refusal names the account and
// its allowed currency. The drawer serves the ap, ar, and banking
// namespaces; catalog parity owns translation completeness across locales.
const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'messages')
const NAMESPACES = ['ap', 'ar', 'banking'] as const

const drawer = (locale: string, namespace: string): Record<string, unknown> => {
  const catalog = JSON.parse(
    readFileSync(join(messagesDir, locale, `${namespace}.json`), 'utf8'),
  ) as { drawer?: Record<string, unknown> }
  assert.ok(catalog.drawer, `${locale}/${namespace}.json must carry the drawer section`)
  return catalog.drawer
}

for (const namespace of NAMESPACES) {
  test(`drawer.currencyMismatch has English copy (${namespace})`, () => {
    const message = drawer('en', namespace).currencyMismatch
    assert.equal(typeof message, 'string', `English must define ${namespace}.drawer.currencyMismatch`)
    for (const param of ['{account}', '{allowed}', '{actual}']) {
      assert.ok(
        (message as string).includes(param),
        `English ${namespace}.drawer.currencyMismatch must interpolate ${param}`,
      )
    }
  })
}
