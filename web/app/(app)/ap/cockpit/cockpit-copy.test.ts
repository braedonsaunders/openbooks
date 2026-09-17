import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function catalog(locale: string) {
  return JSON.parse(
    readFileSync(new URL(`../../../../messages/${locale}/ap.json`, import.meta.url), 'utf8'),
  ) as { cockpit: Record<string, unknown> }
}

function leafPaths(node: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      leafPaths(value, prefix ? `${prefix}.${key}` : key, out)
    }
  } else {
    out.set(prefix, node)
  }
  return out
}

/** F-t04-010: "{count} bills · {pct}%% of open" — the message adds a literal
 * % on top of the value's own % (formatExactPercent returns '0%'). The
 * message must not carry its own percent sign. */
test('the overdue share message carries no literal percent sign', () => {
  const overdueSub = (catalog('en').cockpit.stats as Record<string, string>).overdueSub
  assert.ok(overdueSub, 'en cockpit.stats.overdueSub must exist')
  assert.ok(!overdueSub.includes('%'), `the value already carries %: ${overdueSub}`)
})

/** F-t04-010: the /ap cockpit renders in English under fr/es because the
 * whole cockpit block is missing from those catalogs. Both locales must
 * carry the same key tree as en, with no empty leaves. */
for (const locale of ['fr', 'es']) {
  test(`${locale} carries the full ap cockpit key tree`, () => {
    const expected = leafPaths(catalog('en').cockpit, '', new Map())
    const actual = leafPaths(catalog(locale).cockpit ?? {}, '', new Map())
    assert.deepEqual(
      [...actual.keys()].sort(),
      [...expected.keys()].sort(),
      `${locale} ap.cockpit must carry every en key`,
    )
    for (const [path, value] of actual) {
      assert.equal(typeof value, 'string', `${locale} ap.cockpit.${path} must be a string`)
      assert.ok((value as string).length > 0, `${locale} ap.cockpit.${path} must not be empty`)
    }
  })
}
