import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import { LOCALE_CODES as LOCALES } from "../../../../i18n/config"
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost:4800/projects', matchMediaMatches: false })

const { join: joinPath } = await import('node:path')
const { pathToFileURL: toFileUrl } = await import('node:url')
const worktreeUiSource = `export * from "${toFileUrl(joinPath(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href}"`
stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    '@openbooks/ui': worktreeUiSource,
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const en = (await import('../../../../messages/en/index.ts')).default as Record<string, unknown>
const { MoneyProvider } = await import('../../../../components/money-provider')
const { FinancialsTab } = await import('./FinancialsTab')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const methods = [
  {
    key: 'billable_value',
    name: 'Time & Materials',
    basis: 'Billable value of rated work',
    unratedWork: true,
    separateContractReference: true,
    total: '$0.00',
  },
  {
    key: 'not_to_exceed',
    name: 'Not-to-exceed',
    basis: 'Lower of contract value and billable value of rated work',
    unratedWork: true,
    separateContractReference: true,
    total: '$0.00',
  },
  {
    key: 'contract_field',
    name: 'Fixed price',
    basis: 'The saved contract value prices the job',
    unratedWork: false,
    separateContractReference: false,
    total: '$1,250.00',
  },
  {
    key: 'cost_plus',
    name: 'Cost-plus',
    basis: 'Incurred cost plus the project markup',
    unratedWork: false,
    separateContractReference: true,
    total: '$0.00',
  },
] as const

function financials(method: (typeof methods)[number]['key']) {
  return {
    measures: { total_price: method === 'contract_field' ? '1250.00' : '0.00' },
    layout: [{ measure: 'total_price', label: 'Total job price', variant: 'total' }],
    costByCategory: [],
    costByAccount: [],
    projectType: null,
    costBudgetApplies: false,
    overheadIncludedInTotalCost: false,
    pricingMethod: method,
    contractValue: '1250.00',
  } as never
}

test('financials explain the configured price basis without conflating the contract reference', async (t) => {
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  for (const method of methods) {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
          <MoneyProvider currency="USD">
            <FinancialsTab data={financials(method.key)} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      )
      await tick()
    })

    const view = host.textContent ?? ''
    assert.ok(view.includes(method.name), `${method.key} names its pricing method`)
    assert.ok(view.includes(method.basis), `${method.key} names the actual price basis`)
    assert.ok(view.includes(method.total), `${method.key} shows the independently supplied total price`)
    assert.equal(view.includes('Work without a bill rate is unrated and adds $0 to the billable value.'), method.unratedWork)
    assert.equal(view.includes('Contract value (reference)'), method.separateContractReference)
    if (method.separateContractReference) assert.ok(view.includes('$1,250.00'), `${method.key} keeps the saved contract amount visible as a reference`)
  }
})

test('project pricing copy is localized across supported locales', async () => {
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
      assert.ok(typeof rendered === 'string' && rendered.length > 0 && !rendered.includes(leaf), `${key} must render localized text in ${locale}`)
      if (locale !== 'en') assert.notEqual(rendered, enT(key), `${locale} must localize ${key}`)
    }
  }
})
