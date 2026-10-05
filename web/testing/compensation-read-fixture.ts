import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createTranslator, type AbstractIntlMessages } from 'next-intl'

/** Shared read seams; policy, permission checks, error classes and ICU formatting remain real. */
export function installCompensationReadFixture() {
  const messages = Object.fromEntries(['hrm', 'admin', 'shell'].map((key) => [
    key, JSON.parse(readFileSync(new URL(`../messages/en/${key}.json`, import.meta.url), 'utf8')),
  ])) as AbstractIntlMessages
  const fixture = {
    features: {} as Record<string, boolean>, detail: false, baseCurrency: 'USD', gapReads: 0,
    snapshot: null as { snapshot?: unknown; error?: unknown } | null,
    overview: {
      bands: [] as unknown[], levels: [] as unknown[], families: [] as unknown[], versions: [] as unknown[],
      wages: { asOf: '2026-09-22', workers: 0, covered: 0, missing: 0, ambiguous: 0, groups: [] as unknown[] },
      wageInput: undefined as unknown, error: undefined as unknown,
    },
    translate: (namespace: string) => createTranslator({ locale: 'en', messages, namespace }),
  }
  Object.assign(globalThis, { __compensationReadFixture: fixture })
  const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
  const state = 'const f=globalThis.__compensationReadFixture;'
  const modules: Record<string, string> = {
    'next-intl/server': state + "export async function getLocale(){return 'en'} export async function getTranslations(ns){return f.translate(ns)}",
    '../authz': `export { can } from ${JSON.stringify(new URL('../lib/authz-core.ts', import.meta.url).href)}; export async function getAuthz(){return null}`,
    '../../components/module-home/group-tabs': 'export async function hrmGroupTabs(){return []}',
    '@openbooks/engine/src/platform/business-date.ts': "export async function businessToday(){return '2026-09-22'}",
    '@openbooks/engine/src/hrm/compensation/cycles.ts': state + `
      export async function listCycles(){return []} export async function listCycleLines(){return []}
      export async function cyclePacing(){return {totalPct:null,overBudget:false}}
      export async function getCycle(){return f.detail?{id:'cycle-1',name:'Fall merit round',kind:'merit',status:'open',effectiveOn:'2026-10-01'}:null}`,
    '@openbooks/engine/src/hrm/compensation/bands.ts': state + 'export async function listPayBands(){return f.overview.bands} export async function compaRatioFor(){return null}',
    '@openbooks/engine/src/hrm/compensation/band-headcounts.ts': 'export async function countBandHolders(){return 0}',
    '@openbooks/engine/src/hrm/compensation/architecture.ts': state + `
      export async function listJobLevels(){return f.overview.levels}
      export async function compensationSettings(){return {comparisonAttributeKey:'group',gapThresholdPct:'5',responseDays:null,fteRounding:'up_to_whole',burdenRate:null}}`,
    '@openbooks/engine/hrm/compensation': state + `
      export async function listJobFamilies(){return f.overview.families}
      export async function listPayBandVersions(){return f.overview.versions}
      export async function compensationWageSummary(input){f.overview.wageInput=input;if(f.overview.error)throw f.overview.error;return f.overview.wages}`,
    '@openbooks/engine/src/hrm/compensation/headcount-plans.ts': state + `
      export async function listPlans(){return f.detail?[{id:'plan-1',name:'FY27 growth',status:'draft',fiscalPeriodFrom:'2026-01-01',fiscalPeriodTo:'2026-12-31'}]:[]}
      export async function listPlanLines(){return []}`,
    '@openbooks/engine/src/hrm/compensation/pay-transparency.ts': state + 'export async function latestGapSnapshot(){f.gapReads++;if(f.snapshot?.error)throw f.snapshot.error;return f.snapshot?.snapshot??null}',
    '@openbooks/engine/organization/currencies': state + 'export async function organizationCurrencyOptions(){return [{value:f.baseCurrency,label:f.baseCurrency,scopeValue:null}]}',
    '../setup/ref-options': 'export async function loadEntityOptions(){return []}',
    '@openbooks/engine/src/platform/db.ts': state + `export const db={execute:async(query)=>({rows:JSON.stringify(query).includes('select distinct p.custom')?[{value:'A',label:'A'},{value:'B',label:'B'}]:[{base_currency:f.baseCurrency}]})}`,
  }
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === '../features') return virtual(state + 'export async function isFeatureEnabled(org,key){return f.features[key]??true}')
    if (specifier === '../feature-gates') return virtual('export async function requireFeatureEnabled(){}')
    const owned = ['/web/lib/hrm/compensation.ts', '/web/lib/hrm/workspace-tabs.ts', '/CompensationRegisters.tsx']
      .some((path) => context.parentURL?.endsWith(path))
    return owned && modules[specifier] ? virtual(modules[specifier]) : next(specifier, context)
  } })
  return fixture
}
