import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./PaymentDrawer.tsx', import.meta.url), 'utf8')

test('draft payment saves carry the exact document revision token required by the PATCH API', () => {
  assert.match(
    source,
    /expectedUpdatedAt:\s*doc\.updated_at/,
    'the drawer must echo the loaded updated_at revision on every draft save',
  )
})

test('final payment posting carries the revision token fenced by post-with-applications', () => {
  assert.match(
    source,
    /fetch\('\/api\/payments\/post-with-applications'[\s\S]*?expectedUpdatedAt:\s*doc\.updated_at/,
    'the Pay & post action must send the loaded revision so a stale drawer 409s instead of overwriting the allocation set',
  )
})

test('payment voids carry the revision token required by the void API', () => {
  assert.match(
    source,
    /\/void`,\s*\{[\s\S]*?JSON\.stringify\(\{\s*reason,\s*expectedUpdatedAt/,
    'the void action must echo the loaded revision: /api/documents/[id]/void answers 409 without it, so a token-less void can never succeed',
  )
})

test('a refused Receive & post surfaces the typed message and pins it past the toast', () => {
  assert.match(
    source,
    /async function post\(\)[\s\S]*?readDocumentActionResult\(res\)/,
    'the post action must read through the shared action-result reader: a non-JSON 422 body makes a bare res.json() throw past the toast and wedges the button busy (F-t02-006)',
  )
  assert.match(
    source,
    /async function post\(\)[\s\S]*?setActionError\(message\)[\s\S]*?toast\.error\(message\)/,
    'a refused post must toast the typed message AND pin it as a record-level alert',
  )
  assert.match(
    source,
    /\{actionError \? \(\s*<p role="alert"/,
    'the pinned refusal must render as a persistent alert at the top of the drawer body',
  )
})

test('a failed post never wedges the Receive & post button busy', () => {
  assert.match(
    source,
    /async function post\(\)[\s\S]*?finally\s*\{[\s\S]*?setBusy\(false\)/,
    'the post action must release busy in a finally: a rejected transport must not wedge the button on',
  )
})

test('the drawer title never renders a sync source handle (F-t12-004 remainder)', () => {
  assert.match(
    source,
    /displayDocumentNumber\(doc\.document_number,\s*doc\.reference_number\)/,
    'the receipt title must fall back to the reference through the shared display rule: mirrored rows carry a source handle in document_number',
  )
  assert.doesNotMatch(
    source,
    /\{doc\.document_number\}/,
    'no raw document_number render may remain in the drawer',
  )
})

test('save and void share the surfaced-refusal pattern (no bare res.json, no wedged busy)', () => {
  for (const fn of ['save', 'voidPayment'] as const) {
    assert.match(
      source,
      new RegExp(`async function ${fn}\\(\\)[\\s\\S]*?readDocumentActionResult\\(res\\)`),
      `${fn} must read through the shared action-result reader instead of a bare res.json()`,
    )
    assert.match(
      source,
      new RegExp(`async function ${fn}\\(\\)[\\s\\S]*?setActionError\\(message\\)`),
      `${fn} must pin a typed refusal past its toast`,
    )
    assert.match(
      source,
      new RegExp(`async function ${fn}\\(\\)[\\s\\S]*?finally\\s*\\{[\\s\\S]*?setBusy\\(false\\)`),
      `${fn} must release busy in a finally`,
    )
  }
})

test('the delete-payment confirm resolves through the real catalogs in every locale (F-t04-011)', async () => {
  // 57cba0006 passed t('drawer.deleteConfirmTitle') while t is already
  // scoped to payments.drawer, so es rendered the raw doubled key
  // payments.drawer.drawer.* plus MISSING_MESSAGE. This test composes the
  // exact full key path the component resolves and walks it through the
  // real per-locale catalogs (the same modules web/i18n/request.ts loads)
  // with the same English overlay, so a reintroduced prefix fails here.
  const scope = source.match(/const t = useTranslations\('([^']+)'\)/)?.[1]
  assert.equal(scope, 'payments.drawer')
  const removeBody = source.match(/async function remove\(\) \{([\s\S]*?)\n  \}/)?.[1]
  assert.ok(removeBody, 'remove() must exist')
  const keys = [...removeBody.matchAll(/\bt\(['"]([^'"]+)['"]/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
  for (const key of ['deleteConfirmTitle', 'deleteConfirmBody', 'deleteConfirmAction', 'deleted', 'deleteFailed']) {
    assert.ok(keys.includes(key), `remove() must resolve ${key} through the drawer scope`)
  }
  for (const key of keys) {
    assert.ok(!key.includes('.'), `remove() must not nest a namespace under the drawer scope (got t('${key}'))`)
  }
  assert.ok(!source.includes("'Delete this payment?'"), 'no hardcoded English confirm copy may remain')
  const { LOCALES } = await import('../../../i18n/config.ts')
  const en = (await import('../../../messages/en/index.ts')).default as Messages
  for (const { code: locale } of LOCALES) {
    const overlay = (await import(`../../../messages/${locale}/index.ts`)).default as Messages
    const messages = mergeOverEn(en, overlay)
    for (const key of keys) {
      const value = (messages.payments as Messages | undefined)?.drawer
      const text = (value as Record<string, unknown> | undefined)?.[key]
      assert.equal(
        typeof text,
        'string',
        `${locale} must resolve payments.drawer.${key} (component calls t('${key}') under the drawer scope)`,
      )
      assert.ok((text as string).length > 0, `${locale} payments.drawer.${key} must not be empty`)
    }
  }
})

// Same Messages shape and overlay web/i18n/request.ts applies: a locale's
// catalogs over the English source, so a lagging translation renders
// English instead of a raw key. Kept local because request.ts itself pulls
// next/headers via lib/locale and cannot load under node:test.
type Messages = Record<string, unknown>

function mergeOverEn(base: Messages, overlay: Messages): Messages {
  const out: Messages = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    const cur = out[k]
    out[k] =
      v && typeof v === 'object' && cur && typeof cur === 'object' ? mergeOverEn(cur as Messages, v as Messages) : v
  }
  return out
}
