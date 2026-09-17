import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// PartyDrawer is a client component, but its exact decimal formatter is pure.
// Resolve the app's @/ alias so this focused test can exercise that production
// helper without requiring a browser or a Next.js runtime.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const React = await import('react')
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const { formatCreditLimit, rememberDrawerTab } = await import('./PartyDrawer.tsx')
const drawerSource = readFileSync(new URL('./PartyDrawer.tsx', import.meta.url), 'utf8')

test('credit-limit display preserves large persisted numeric values exactly', () => {
  assert.equal(formatCreditLimit('9007199254740993.0000'), '9007199254740993.00')
})

test('credit-limit display rounds fractional cents with exact decimal arithmetic', () => {
  assert.equal(formatCreditLimit('86.6150'), '86.62')
  assert.equal(formatCreditLimit(null), '')
})

// F-t08-003: switching employee drawer tabs unmounted the payroll/wage
// panels, silently discarding unsaved profile edits. Visited compensation
// tabs must stay mounted (hidden) so their local edits survive a switch.
test('remembering a visited drawer tab keeps it without mutating the set', () => {
  const kept = rememberDrawerTab(new Set(['overview']), 'payroll')
  assert.ok(kept.has('overview'))
  assert.ok(kept.has('payroll'))
})

test('remembering an already kept tab returns the same set', () => {
  const kept = new Set(['overview', 'payroll'] as const)
  assert.equal(rememberDrawerTab(kept, 'payroll'), kept)
})

test('the drawer routes tab switches through the visit-recording helper', () => {
  assert.match(drawerSource, /rememberDrawerTab\(/)
  assert.match(drawerSource, /onClick=\{\(\) => showTab\(item\.key\)\}/)
})

test('the wage and payroll panels stay mounted once visited instead of unmounting', () => {
  assert.match(drawerSource, /keptTabs\.has\('wages'\)/)
  assert.match(drawerSource, /keptTabs\.has\('payroll'\)/)
  assert.match(drawerSource, /hidden=\{tab !== 'wages'\}/)
  assert.match(drawerSource, /hidden=\{tab !== 'payroll'\}/)
  assert.doesNotMatch(drawerSource, /\{tab === 'wages' &&/)
  assert.doesNotMatch(drawerSource, /\{tab === 'payroll' &&/)
})

// F-t05-002: the Kind control offered only company|person while parties store
// customer/vendor/employee kinds, so the control misread the record and the
// PATCH it echoed back 422'd. The control must offer the stored vocabulary,
// the view label must render it, and a refused save must pin its reason on
// the record (staying in edit mode) instead of reporting success.
test('the kind control covers the stored vocabulary and save refusals stay visible', () => {
  for (const kind of ['company', 'person', 'customer', 'vendor', 'employee']) {
    assert.match(drawerSource, new RegExp(`<option value="${kind}">`))
  }
  assert.doesNotMatch(drawerSource, /kind === 'person' \? t\('kindPerson'\) : t\('kindCompany'\)/)
  assert.match(drawerSource, /const \[saveError, setSaveError\] = useState<string \| null>\(null\)/)
  assert.match(drawerSource, /<p role="alert"[\s\S]*?\{saveError/)
  assert.match(drawerSource, /setSaveError\(null\)/)
})

// F-t02-015: the blank-name guard and the statement link rendered raw
// `parties.drawer.drawer.*` keys in every locale, because the drawer called
// t('drawer.nameRequired') / t('drawer.viewStatement') under the
// parties.drawer namespace instead of the bare keys that exist in all 7
// catalogs. Every static t('…') key in this file must resolve through the
// real locale indexes — a locale-file grep cannot catch a wrong nesting.
test('every static drawer key resolves in all locales (no doubled namespace)', async () => {
  const { createTranslator } = await import('next-intl')
  const keys = new Set<string>()
  for (const match of drawerSource.matchAll(/(?<![A-Za-z])t\('([^']+)'\)/g)) keys.add(match[1]!)
  assert.ok(keys.size > 0, 'expected static translation keys in the drawer')
  assert.ok(
    ![...keys].some((key) => key.startsWith('drawer.')),
    `drawer-namespace keys must not re-prefix 'drawer.': ${[...keys].filter((key) => key.startsWith('drawer.')).join(', ')}`,
  )
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const) {
    const messages = (await import(`../../../messages/${locale}/index.ts`)).default as Record<string, unknown>
    const t = createTranslator({ locale, namespace: 'parties.drawer', messages: messages as never } as never) as unknown as (
      lookup: string,
    ) => string
    for (const key of keys) {
      // A miss renders the full key path (parties.drawer.<key>), never throws.
      const missPaths = new Set([key, `parties.drawer.${key}`])
      let rendered: string | undefined
      try {
        rendered = t(key)
      } catch {
        assert.fail(`drawer key ${JSON.stringify(key)} misses in the ${locale} catalog`)
      }
      assert.ok(
        typeof rendered === 'string' && rendered.length > 0 && !missPaths.has(rendered),
        `drawer key ${JSON.stringify(key)} must render translated text in ${locale}, got ${JSON.stringify(rendered)}`,
      )
    }
  }
})
