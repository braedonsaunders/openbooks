import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'
import { createTranslator } from 'next-intl'

const { RATED_WORK_METHODS } = (await tsImport('./FinancialsTab.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
})) as {
  RATED_WORK_METHODS: ReadonlySet<string>
}

const tab = readFileSync(new URL('./FinancialsTab.tsx', import.meta.url), 'utf8')
const cockpit = readFileSync(new URL('../_cockpit-data.ts', import.meta.url), 'utf8')

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

/**
 * UX-11: Financials showed Total job price $0 beside the saved Contract
 * value without naming the Time & Materials basis. The tab must name the
 * pricing method and basis next to Total job price, explain unrated work,
 * and keep the reference Contract value visibly distinct.
 */
test('UX-11: only rate-built methods carry the unrated-work explanation', () => {
  assert.ok(RATED_WORK_METHODS.has('billable_value'), 'T&M prices from rated work')
  assert.ok(RATED_WORK_METHODS.has('not_to_exceed'), 'capped prices from rated work')
  assert.ok(!RATED_WORK_METHODS.has('contract_field'), 'fixed price is the saved value, not rated work')
  assert.ok(!RATED_WORK_METHODS.has('cost_plus'), 'cost-plus marks up cost, not rated work')
})

test('UX-11: financials name the pricing method and basis beside the price', () => {
  assert.match(tab, /cockpit\.pricingMethod\.\$\{data\.pricingMethod\}/)
  assert.match(tab, /cockpit\.pricingBasis\.\$\{data\.pricingMethod\}/)
  assert.match(tab, /RATED_WORK_METHODS\.has\(data\.pricingMethod\)/)
  assert.match(tab, /t\('cockpit\.unratedWorkNote'\)/)
  // The Total job price line carries its basis, not the generic
  // contract-price hint.
  assert.match(tab, /line\.measure === 'total_price'/)
  assert.match(tab, /cockpit\.pricingBasis\.\$\{data\.pricingMethod\}.*as never/)
})

test('UX-11: reference contract value stays distinct from the priced total', () => {
  assert.match(tab, /data\.pricingMethod !== 'contract_field'/)
  assert.match(tab, /t\('cockpit\.contractValueReference'\)/)
  assert.match(tab, /t\('cockpit\.contractValueReferenceHint'\)/)
  assert.match(tab, /money\(data\.contractValue\)/)
  assert.match(cockpit, /pricingMethod: projectType\.financialProfile\.totalPrice\.method/)
  assert.match(cockpit, /contractValue: financials\.contractValue/)
})

test('UX-11: pricing copy is translated in every locale', async () => {
  const keys = [
    'cockpit.pricingMethod.contract_field',
    'cockpit.pricingMethod.billable_value',
    'cockpit.pricingMethod.not_to_exceed',
    'cockpit.pricingMethod.cost_plus',
    'cockpit.pricingBasis.contract_field',
    'cockpit.pricingBasis.billable_value',
    'cockpit.pricingBasis.not_to_exceed',
    'cockpit.pricingBasis.cost_plus',
    'cockpit.unratedWorkNote',
    'cockpit.contractValueReference',
    'cockpit.contractValueReferenceHint',
  ]
  const en = (await import('../../../../messages/en/index.ts')).default as Record<string, unknown>
  const enT = createTranslator({ locale: 'en', namespace: 'projects', messages: en as never } as never) as unknown as (
    lookup: string,
  ) => string
  assert.equal(enT('cockpit.pricingMethod.billable_value'), 'Time & Materials')
  assert.equal(enT('cockpit.pricingBasis.billable_value'), 'Billable value of rated work')
  for (const locale of LOCALES) {
    const messages = (await import(`../../../../messages/${locale}/index.ts`)).default as Record<string, unknown>
    const t = createTranslator({ locale, namespace: 'projects', messages: messages as never } as never) as unknown as (
      lookup: string,
    ) => string
    for (const key of keys) {
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
        assert.notEqual(rendered, enT(key), `${locale} must localize ${key}`)
      }
    }
  }
})
