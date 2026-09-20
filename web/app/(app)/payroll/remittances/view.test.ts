import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'
import type { RemittanceGroup } from '@openbooks/engine/src/payroll/remittance.ts'

const state: { error: Error | null; groups: RemittanceGroup[] | null } = { error: null, groups: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('remittances-page-test')] = state
const stubs: Record<string, string> = {
  'server-only': 'export {}',
  'next-intl/server': 'export async function getTranslations(){ return key => key }',
  '@openbooks/engine/src/platform/business-date.ts': "export async function businessToday(){ return '2026-09-13' }",
  '../../../../lib/authz': "export async function requirePermission(){ return { user: { orgId: 'test' } } }; export function can(){ return true }",
  '../../../../lib/feature-gates': 'export async function requireFeatureEnabled(){}',
  '../../../../components/module-home/group-tabs': 'export async function groupTabs(){ return [] }',
  '../../../../lib/payroll-scoped-views': "export async function scopedRemittanceSummary(){ const s=globalThis[Symbol.for('remittances-page-test')]; if(s.error)throw s.error; return s.groups }",
  'next/navigation': "export function notFound(){ throw new Error('NEXT_HTTP_ERROR_FALLBACK;404') }",
}
registerHooks({
  resolve(specifier, context, next) {
    if (stubs[specifier]) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]) }
    return next(specifier, context)
  },
})
const { loadRemittances, remittancesSpec } = await import('./view')

test('remittances retains the selected period and explains historical payroll refusals without offering bills', async () => {
  for (const message of [
    'Committed payroll has an unknown historical filing account.',
    'Committed payroll has an unknown historical liability account.',
  ]) {
    state.error = new PayrollError(message)
    const data = await loadRemittances({ from: '2026-07-01', to: '2026-07-31' })
    assert.equal(data.populationRefusal, message)
    assert.deepEqual(data.groups, [])
    assert.equal(data.from, '2026-07-01')
    assert.equal(data.to, '2026-07-31')
    assert.equal(data.canCreate, false)
    assert.ok(JSON.stringify(remittancesSpec(data)).includes(message), 'the refusal must reach the rendered widget')
  }
})

test('remittances keeps an empty valid period distinct from a refused population', async () => {
  state.error = null
  state.groups = []
  const data = await loadRemittances({})
  assert.equal(data.populationRefusal, null)
  assert.equal(data.canCreate, true)
  assert.equal(data.from, '2026-08-01')
  assert.equal(data.to, '2026-08-31')
})

test('remittances preserves scope refusals and unexpected failures', async () => {
  state.error = null
  state.groups = null
  await assert.rejects(loadRemittances({}), /NEXT_HTTP_ERROR_FALLBACK;404/)
  state.error = new Error('database unavailable')
  await assert.rejects(loadRemittances({}), error => error === state.error)
})
