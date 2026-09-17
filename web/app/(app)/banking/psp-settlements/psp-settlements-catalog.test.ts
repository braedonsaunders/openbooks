import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F-t06-004: the Stripe payload textarea documented nothing — a missing
// `type` 500d the importer with no schema help. The workspace now shows the
// expected row shape under the payload field. A new user-visible string is a
// catalog key in ALL locales — never English pasted into a non-English
// catalog — pinned here through the real catalog files, plus the loader and
// workspace wiring that must actually use it.
const messagesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'messages',
)
const LOCALES = ['en', 'fr', 'es', 'de', 'ja', 'zh', 'pt-BR'] as const

const pspSettlements = (locale: string): Record<string, unknown> => {
  const catalog = JSON.parse(
    readFileSync(join(messagesDir, locale, 'banking.json'), 'utf8'),
  ) as { pspSettlements?: Record<string, unknown> }
  assert.ok(catalog.pspSettlements, `${locale}/banking.json must carry the pspSettlements section`)
  return catalog.pspSettlements
}

test('pspSettlements.payloadShapeHint is translated in every locale', () => {
  const en = pspSettlements('en').payloadShapeHint
  assert.equal(typeof en, 'string')
  assert.ok((en as string).length > 0)
  for (const locale of LOCALES) {
    const message = pspSettlements(locale).payloadShapeHint
    assert.equal(typeof message, 'string', `${locale} must translate banking.pspSettlements.payloadShapeHint`)
    assert.ok((message as string).length > 0, `${locale} payloadShapeHint must not be empty`)
    // The documented shape names the row fields; every locale keeps them so
    // the hint stays actionable, not decorative.
    for (const field of ['"id"', '"type"', '"amount"', '"currency"']) {
      assert.ok(
        (message as string).includes(field),
        `${locale} payloadShapeHint must name ${field}`,
      )
    }
  }
  for (const locale of LOCALES.slice(1)) {
    assert.notEqual(
      pspSettlements(locale).payloadShapeHint,
      en,
      `${locale} must not paste the English copy`,
    )
  }
})

test('the loader and workspace wire the subsidiary picker and shape hint (F-t06-004)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const view = readFileSync(join(dir, 'view.ts'), 'utf8')
  const sections = readFileSync(join(dir, 'sections.tsx'), 'utf8')
  assert.match(view, /payloadShapeHint: t\('payloadShapeHint'\)/, 'the loader must resolve the hint through the real catalog')
  assert.match(view, /initialSubsidiaries: data\.subsidiaries/, 'the spec must carry the picker options')
  assert.match(sections, /subsidiaryId: subsidiaryId \|\| undefined/, 'the import must send the picked subsidiary')
  assert.match(
    sections,
    /disabled=\{!externalRef \|\| \(needsSubsidiaryChoice && !subsidiaryId\)\}/,
    'multi-entity orgs must pick the posting entity before the draft exists',
  )
  assert.match(sections, /\{strings\.payloadShapeHint\}/, 'the workspace must render the hint')
  assert.match(
    sections,
    /return \{ ok: false, error: typeof message === 'string' && message \? message : null \}/,
    'mutation refusals must resolve to the server reason for the pinned alert',
  )
})
