import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const denied = { kind: 'notFound' }
Object.assign(globalThis, { __derivedPreviewDbCalls: 0, __derivedPreviewDenied: denied })
const virtual = (source: string) => ({ shortCircuit: true as const, url: `data:text/javascript,${encodeURIComponent(source)}` })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next/navigation') return virtual('export function notFound(){ throw globalThis.__derivedPreviewDenied }')
  if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}')
  if (specifier.endsWith('/platform/db.ts')) return virtual('export const db={execute(){globalThis.__derivedPreviewDbCalls++;return {rows:[]}}}')
  if (specifier.endsWith('/platform/business-date.ts')) return virtual('export async function businessToday(){return "2026-01-01"}')
  if (specifier.endsWith('/payroll/derived-earnings.ts')) return virtual('export async function previewDerivedRule(){throw Error("must not run")}')
  if (specifier.endsWith('/lib/authz') && (context.parentURL ?? '').endsWith('/DerivedRulePreviewSection.tsx')) return virtual('export async function guardRootSubsidiaryScope(){return globalThis.__derivedPreviewDenied}')
  if (specifier.endsWith('/lib/list-params')) return virtual('export function pickString(){}')
  if (specifier.endsWith('/components/date-range-filter')) return virtual('export function DateRangeFilter(){return null}')
  if (specifier.endsWith('/components/list-filter-select')) return virtual('export function ListFilterSelect(){return null}')
  if (specifier.endsWith('/DerivedRulePreviewTable')) return virtual('export function DerivedRulePreviewTable(){return null}')
  if (specifier === '@openbooks/ui') return virtual('export function Alert(){return null}; export function Badge(){return null}')
  return next(specifier, context)
} })

const { DerivedRulePreviewSection } = await import('./DerivedRulePreviewSection')

test('derived payroll preview refuses restricted callers before reading rules or calculating amounts', async () => {
  await assert.rejects(DerivedRulePreviewSection({
    authz: { user: { orgId: 'org-a' }, permissions: new Set(), allowedSubsidiaryIds: new Set(['sub-a']) } as never,
    orgId: 'org-a',
    searchParams: {},
  }), (error) => error === denied)
  assert.equal(Reflect.get(globalThis, '__derivedPreviewDbCalls'), 0)
})
