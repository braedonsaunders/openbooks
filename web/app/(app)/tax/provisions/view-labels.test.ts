import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// F3-89: the provision run list built its year/version cells with hardcoded
// English template literals (`FY${year}` / `v${version}`), so every locale
// read English prefixes — German drops the FY prefix entirely in the detail
// title ("Abgrenzung {year}"), Japanese suffixes 年度. The loader must
// render both cells through the catalog's ICU patterns, in every locale.
// Loader-proved against the REAL catalog files: the mock translator reads
// web/messages/<locale>/tax.json and substitutes {year}/{version), so a
// hardcoded prefix fails every non-English locale.

const dir = dirname(fileURLToPath(import.meta.url))
const MESSAGES = join(dir, '..', '..', '..', '..', 'messages')
const LOCALES = ['en', 'fr', 'es', 'de', 'ja', 'zh', 'pt-BR'] as const

const stateKey = Symbol.for('openbooks.tax-provisions-labels-test')
interface LabelState {
  messages: Record<string, unknown>
}
const labelState: LabelState = { messages: {} }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = labelState

const RUN = {
  id: 'run-1',
  fiscalYear: 2025,
  version: 2,
  status: 'posted',
  totalExpense: '1234.56',
  effectiveRatePercent: null,
  createdAt: '2026-01-15T00:00:00.000Z',
}

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      export async function requirePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null, permissions: ['reports.read', 'reports.create'] }
      }
      export function can() { return true }
    `,
  ],
  [
    'mock:intl',
    `
      const state = globalThis[Symbol.for('openbooks.tax-provisions-labels-test')]
      export async function getTranslations(namespace) {
        return (key, params) => {
          let scope = state.messages
          for (const part of String(namespace).split('.')) scope = scope?.[part]
          let out = String(scope?.[key] ?? key)
          for (const [name, value] of Object.entries(params ?? {})) out = out.replaceAll('{' + name + '}', String(value))
          return out
        }
      }
    `,
  ],
  [
    'mock:money',
    `export async function getMoneyFormatter() { return { money: (value) => String(value) } }`,
  ],
  ['mock:data', `export async function orgInfo() { return { base_currency: 'USD' } }`],
  [
    'mock:provision',
    `export async function listProvisionRuns() { return [${JSON.stringify(RUN)}] }`,
  ],
  [
    'mock:viewspec',
    `
      export function page(spec) { return spec }
      export function pageHeader(header) { return header }
      export function ref() { return () => false }
      export function widget(kind, props) { return { kind, ...props } }
      export function widgetBlock(kind, props) { return { kind, ...props } }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', 'mock:authz'],
  ['next-intl/server', 'mock:intl'],
  ['@/lib/money-server', 'mock:money'],
  ['../../../../lib/data', 'mock:data'],
  ['@openbooks/engine/src/tax-returns/income-tax-provision.ts', 'mock:provision'],
  ['@braedonsaunders/appkit-viewspec', 'mock:viewspec'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const viewUrl = './view.ts?provisions-labels-test'
const { loadTaxProvisions } = (await import(viewUrl)) as typeof import('./view.ts')
hooks.deregister()

function provisionsOf(locale: string): Record<string, string> {
  const tax = JSON.parse(readFileSync(join(MESSAGES, locale, 'tax.json'), 'utf8')) as Record<
    string,
    unknown
  >
  return (tax.provisions ?? {}) as Record<string, string>
}

for (const locale of LOCALES) {
  test(`${locale} renders the run year/version through the catalog patterns`, async () => {
    const provisions = provisionsOf(locale)
    for (const key of ['fiscalYearLabel', 'versionLabel'] as const) {
      assert.ok(provisions[key], `${locale} is missing tax.provisions.${key}`)
    }
    labelState.messages = {
      tax: JSON.parse(readFileSync(join(MESSAGES, locale, 'tax.json'), 'utf8')),
    }

    const data = await loadTaxProvisions()
    assert.equal(data.rows.length, 1)
    assert.equal(
      data.rows[0]!.fiscalYearLabel,
      String(provisions.fiscalYearLabel)
        .replaceAll('{year}', String(RUN.fiscalYear)),
      `${locale} must render the fiscal-year cell from the catalog pattern`,
    )
    assert.equal(
      data.rows[0]!.versionLabel,
      String(provisions.versionLabel).replaceAll('{version}', String(RUN.version)),
      `${locale} must render the version cell from the catalog pattern`,
    )
  })
}

test('no locale falls back to the English FY prefix', async () => {
  for (const locale of LOCALES) {
    if (locale === 'en') continue
    labelState.messages = {
      tax: JSON.parse(readFileSync(join(MESSAGES, locale, 'tax.json'), 'utf8')),
    }
    const data = await loadTaxProvisions()
    assert.ok(
      !data.rows[0]!.fiscalYearLabel.startsWith('FY'),
      `${locale} renders the English FY prefix instead of its own pattern`,
    )
  }
})
