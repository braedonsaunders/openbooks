import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranslator } from 'next-intl'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function usePathname(){return '/reports/aging'}export function useSearchParams(){return new URLSearchParams()}export function useRouter(){return {}}`,
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
// Classic-JSX fallback: the shared tsx cache can serve a classic transform,
// which resolves bare React from the global scope, not the module scope.
Object.assign(globalThis, { React })
const { renderToString } = await import('react-dom/server')
const { PartyLinkCell } = await import('./sections.tsx')

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

/**
 * OM-06: synthetic opening-balance JE lines render as bare no-party amounts
 * that read like operating items missing a counterparty. The partyless cell
 * must carry provenance (what is proven: no counterparty recorded — never
 * an assertion that every such row is an opening balance, which would mask
 * a genuine control break), and the partners drill opens the JE lines
 * behind the row under a provenance title. Totals are untouched.
 */
test('partyless aging cell names the missing counterparty', () => {
  const html = renderToString(
    React.createElement(PartyLinkCell, {
      partyId: null,
      partyName: '(no party)',
      href: '/reports/statements/null?side=ar',
      note: 'No counterparty recorded — for example an opening-balance journal.',
    }),
  )
  assert.ok(html.includes('(no party)'), 'the established placeholder stays')
  assert.ok(html.includes('No counterparty recorded'), 'provenance renders beside the placeholder')
  assert.ok(!html.includes('href='), 'no statement link for a partyless row')
})

test('named party cell links with no provenance note', () => {
  const html = renderToString(
    React.createElement(PartyLinkCell, {
      partyId: 'p1',
      partyName: 'Acme',
      href: '/reports/statements/p1?side=ar',
      note: null,
    }),
  )
  assert.ok(html.includes('Acme'), 'the party name renders')
  assert.ok(!html.includes('No counterparty recorded'), 'no provenance on named rows')
})

test('provenance copy is translated in every locale', async () => {
  const en = (await import('../../../../messages/en/index.ts')).default as Record<string, unknown>
  const enAging = createTranslator({ locale: 'en', namespace: 'reports', messages: en as never } as never) as unknown as (
    lookup: string,
  ) => string
  assert.equal(
    enAging('aging.noPartyNote'),
    'No counterparty recorded — for example an opening-balance journal.',
  )
  assert.equal(enAging('partners.noPartyDrillLabel'), 'Control-account lines with no counterparty')
  for (const locale of LOCALES) {
    const messages = (await import(`../../../../messages/${locale}/index.ts`)).default as Record<string, unknown>
    const t = createTranslator({ locale, namespace: 'reports', messages: messages as never } as never) as unknown as (
      lookup: string,
    ) => string
    for (const key of ['aging.noPartyNote', 'partners.noPartyDrillLabel']) {
      let rendered: string
      try {
        rendered = t(key)
      } catch (error) {
        assert.fail(`${key} misses in the ${locale} catalog: ${String(error)}`)
      }
      const leaf = key.split('.').pop()!
      assert.ok(
        typeof rendered === 'string' && rendered.length > 0 && !rendered.includes(leaf),
        `${key} must render translated text in ${locale}, got ${JSON.stringify(rendered)}`,
      )
      if (locale !== 'en') {
        assert.notEqual(rendered, enAging(key), `${locale} must localize ${key}`)
      }
    }
  }
})
