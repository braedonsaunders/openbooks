import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranslator } from 'next-intl'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function usePathname(){return '/reports/statements/p1'}export function useSearchParams(){return new URLSearchParams()}export function useRouter(){return {}}`,
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { AgingStrip } = await import('./sections.tsx')

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

function stripProps(asOfLabel: string) {
  const drill = (bucket?: 'current' | 'b1' | 'b2' | 'b3' | 'b4') => ({
    kind: 'aging' as const,
    label: 'Acme · Current',
    side: 'ar' as const,
    asOf: '2026-09-30',
    partyId: 'p1',
    ...(bucket ? { bucket } : {}),
  })
  return {
    cells: [
      { key: 'current', label: 'Current', value: '$100.00', drill: drill('current') },
      { key: 'b1', label: '1–30', value: '$50.00', drill: drill('b1') },
    ],
    totalLabel: 'Total',
    total: '$150.00',
    totalDrill: drill(),
    asOfLabel,
  }
}

/**
 * UX-02: statement aging buckets omit their as-of date, making two correctly
 * different bucket views appear inconsistent. The strip must show the
 * selected period-end date beside the buckets, without changing any amount.
 */
test('UX-02: aging strip shows the selected period-end date beside the buckets', () => {
  const html = renderToString(React.createElement(AgingStrip, stripProps('Aging as of 2026-09-30')))
  assert.ok(html.includes('Aging as of 2026-09-30'), 'the as-of caption must render')
  const captionIndex = html.indexOf('Aging as of 2026-09-30')
  const firstBucketIndex = html.indexOf('Current')
  assert.ok(captionIndex < firstBucketIndex, 'the as-of date must sit adjacent to (before) the bucket strip')
})

test('UX-02: as-of caption changes no amount', () => {
  const html = renderToString(React.createElement(AgingStrip, stripProps('Aging as of 2026-09-30')))
  for (const amount of ['$100.00', '$50.00', '$150.00']) {
    assert.ok(html.includes(amount), `amount ${amount} must still render`)
  }
})

test('UX-02: statements.agingAsOf is translated in every locale', async () => {
  for (const locale of LOCALES) {
    const messages = (await import(`../../../../../messages/${locale}/index.ts`)).default as Record<string, unknown>
    const t = createTranslator({ locale, namespace: 'reports', messages: messages as never } as never) as unknown as (
      lookup: string,
      values?: Record<string, string>,
    ) => string
    let rendered: string
    try {
      rendered = t('statements.agingAsOf', { date: '2026-09-30' })
    } catch (error) {
      assert.fail(`statements.agingAsOf misses in the ${locale} catalog: ${String(error)}`)
    }
    assert.ok(
      typeof rendered === 'string' && rendered.includes('2026-09-30') && !rendered.includes('agingAsOf'),
      `statements.agingAsOf must render the date in ${locale}, got ${JSON.stringify(rendered)}`,
    )
  }
  const en = (await import('../../../../../messages/en/index.ts')).default as Record<string, unknown>
  const enT = createTranslator({ locale: 'en', namespace: 'reports', messages: en as never } as never) as unknown as (
    lookup: string,
    values?: Record<string, string>,
  ) => string
  assert.equal(enT('statements.agingAsOf', { date: '2026-09-30' }), 'Aging as of 2026-09-30')
})
