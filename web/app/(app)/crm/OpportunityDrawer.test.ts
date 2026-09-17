import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createTranslator } from 'next-intl'

const source = readFileSync(new URL('./OpportunityDrawer.tsx', import.meta.url), 'utf8')

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

/**
 * F-t12-009 residual: with no account the Create estimate button was a dead
 * click in one build (disabled with no reason) and a generic toast in the
 * other (the server's specific refusal — unsaved account, inactive record —
 * was discarded by `if(!response.ok)throw new Error()`). Both paths must
 * name the prerequisite: the button disables with the translated reason,
 * and a server refusal toasts the server's reason.
 */
function estimateFunction(): string {
  const match = source.match(/async function estimate\(\)\{[\s\S]*?setBusy\(false\)\}\}/)
  assert.ok(match?.[0], 'the drawer still has an estimate action')
  return match[0]
}

test('estimate refusal toasts the server reason instead of discarding it', () => {
  const fn = estimateFunction()
  // The refusal branch must prefer the endpoint's reason (no account on the
  // stored row, inactive record) over the generic failure toast.
  assert.match(fn, /result\?\.error \?\? t\('opportunities\.estimateFailed'\)/)
  assert.doesNotMatch(fn, /if\(!response\.ok\)throw new Error\(\)/)
})

test('no-account estimate button disables with the translated reason in every locale', async () => {
  assert.match(source, /disabled=\{busy\|\|!form\.partyId\}/)
  assert.match(source, /title=\{estimateBlockedReason\?\?undefined\}/)
  assert.match(source, /t\('opportunities\.estimateNeedsAccount'\)/)
  for (const locale of LOCALES) {
    const messages = (await import(`../../../messages/${locale}/index.ts`)).default as Record<string, unknown>
    const t = createTranslator({ locale, namespace: 'crm', messages: messages as never } as never) as unknown as (
      lookup: string,
    ) => string
    let rendered: string
    try {
      rendered = t('opportunities.estimateNeedsAccount')
    } catch (error) {
      assert.fail(`estimateNeedsAccount misses in the ${locale} catalog: ${String(error)}`)
    }
    assert.ok(
      typeof rendered === 'string' && rendered.length > 0 && !rendered.includes('estimateNeedsAccount'),
      `estimateNeedsAccount must render translated text in ${locale}, got ${JSON.stringify(rendered)}`,
    )
  }
  const en = (await import('../../../messages/en/index.ts')).default as Record<string, unknown>
  const enT = createTranslator({ locale: 'en', namespace: 'crm', messages: en as never } as never) as unknown as (
    lookup: string,
  ) => string
  assert.equal(enT('opportunities.estimateNeedsAccount'), 'Set an account before creating an estimate')
})
