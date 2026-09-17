import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createTranslator } from 'next-intl'

const source = readFileSync(new URL('./AccountDrawer.tsx', import.meta.url), 'utf8')

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

/**
 * F-t12-006: the Owner empty option rendered the raw key
 * "common.labels.unassigned" then "crm.unassigned" — both misses, because
 * the label lives at crm.fields.unassigned, not at either root. A
 * locale-file grep cannot catch a wrong nesting: this resolves the exact
 * key the drawer references through the real locale indexes and next-intl,
 * the same path the drawer renders through.
 */
function ownerEmptyOptionKey(): string {
  const ownerLine = source.split('\n').find((line) => line.includes("t('fields.owner')"))
  assert.ok(ownerLine, 'the drawer still renders an owner field')
  const match = ownerLine.match(/<option value="">{t\('([^']+)'\)}<\/option>/)
  assert.ok(match?.[1], 'the owner picker still has an empty option with a translated label')
  return match[1]
}

test('lead/prospect owner empty option resolves through the real message loader', async () => {
  const key = ownerEmptyOptionKey()
  for (const locale of LOCALES) {
    const messages = (await import(`../../../messages/${locale}/index.ts`)).default as Record<string, unknown>
    const t = createTranslator({ locale, namespace: 'crm', messages: messages as never } as never) as unknown as (lookup: string) => string
    let rendered: string
    try {
      rendered = t(key)
    } catch (error) {
      assert.fail(`owner key ${JSON.stringify(key)} misses in the ${locale} catalog: ${String(error)}`)
    }
    assert.ok(
      typeof rendered === 'string' && rendered.length > 0 && !rendered.includes('.'),
      `owner key ${JSON.stringify(key)} must render translated text in ${locale}, got ${JSON.stringify(rendered)}`,
    )
  }
  const en = (await import('../../../messages/en/index.ts')).default as Record<string, unknown>
  const ten = createTranslator({ locale: 'en', namespace: 'crm', messages: en as never } as never) as unknown as (lookup: string) => string
  assert.equal(ten(ownerEmptyOptionKey()), 'Unassigned')
})

test('lead/prospect first save carries the party revision token', () => {
  assert.match(
    source,
    /buildAccountIdentityPatch\(party,\s*form\)/,
    'the identity PATCH must go through the create-safe builder: /api/parties/[id] answers 409 without the loaded updated_at revision, and 422 when a draft save carries a status change',
  )
  assert.doesNotMatch(
    source,
    /isActive:\s*true,\s*expectedUpdatedAt/,
    'the create path must not send a status change alongside the revision: isActive:true against an is_active=false draft trips the status-change guard and blocks creation',
  )
})
