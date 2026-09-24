import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const denied = { kind: 'notFound' }
Object.assign(globalThis, { __payrollSetupLauncherCalled: false })
const virtual = (source: string) => ({ shortCircuit: true as const, url: `data:text/javascript,${encodeURIComponent(source)}` })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return virtual('export {}')
  if (specifier === 'next/navigation') return virtual('export function notFound(){ throw globalThis.__payrollSetupDenied }')
  if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}')
  if (specifier.endsWith('/lib/authz') && (context.parentURL ?? '').endsWith('/admin/setup/payroll/view.ts')) {
    return virtual('export async function requirePermission(){return {user:{orgId:"org-a"},allowedSubsidiaryIds:new Set(["sub-a"])}}; export async function guardRootSubsidiaryScope(){return globalThis.__payrollSetupDenied}; export function can(){return false}')
  }
  if (specifier.endsWith('/lib/feature-gates')) return virtual('export async function requireFeatureEnabled(){}')
  if (specifier.endsWith('/lib/list-params')) return virtual('export function pickString(){}')
  if (specifier.endsWith('/lib/setup/registry')) return virtual('export const SETUP_ENTITY_BY_KEY=new Map()')
  if (specifier.endsWith('/lib/setup/payroll-derived-rules')) return virtual('export const PAY_DERIVED_RULES_ENTITY={key:"derived"}')
  if (specifier.endsWith('/lib/setup/payroll-holidays')) return virtual('export const PAYROLL_HOLIDAYS_ENTITY={key:"holidays"}')
  if (specifier.includes('/payroll/packs')) return virtual('export const PAYROLL_COUNTRY_PACKS={}')
  if (specifier === './sections' && (context.parentURL ?? '').endsWith('/admin/setup/payroll/view.ts')) return virtual('export async function launcherDataFor(){globalThis.__payrollSetupLauncherCalled=true;return {}}')
  return next(specifier, context)
} })

Object.assign(globalThis, { __payrollSetupDenied: denied })
const { loadPayrollSetup } = await import('./view')

test('payroll setup refuses a subsidiary-restricted caller before serializing org-wide launcher metadata', async () => {
  await assert.rejects(loadPayrollSetup({}), (error) => error === denied)
  assert.equal(Reflect.get(globalThis, '__payrollSetupLauncherCalled'), false)
})
