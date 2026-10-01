import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

const catalog = JSON.parse(readFileSync(new URL('../../messages/en/hrm.json', import.meta.url), 'utf8'))
;(globalThis as Record<string, unknown>).__myAwardsCatalog = catalog
registerHooks({
  resolve(specifier, context, next) {
    const owned = context.parentURL?.endsWith('/web/lib/hrm/my-benefit-awards.ts')
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (owned && specifier === 'next-intl/server') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export async function getTranslations() { return (key) => key.split('.').reduce((node, part) => node?.[part], globalThis.__myAwardsCatalog) }`) }
    if (owned && specifier === '@openbooks/engine/hrm/benefits') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export async function myBenefitStatement(query) { globalThis.__statementQuery = query; if (globalThis.__statementFailure) throw new Error(globalThis.__statementFailure); return globalThis.__statementRows }`) }
    if (owned && specifier === '../money-server') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export async function getMoneyFormatter() { return { money: (value, opts) => opts.currency + ' ' + value } }`) }
    return next(specifier, context)
  },
})
const { loadMyBenefitAwards } = await import('./my-benefit-awards.ts')
const state = globalThis as Record<string, unknown>
const authz = { user: { orgId: 'org', id: 'employee-login' } } as never

test('self-service award view separates paid from pending and projects no company evidence or actor ids', async () => {
  const base = { id: 'award', programName: 'Recognition', periodFrom: '2026-01-01', periodTo: '2026-01-31', currency: 'USD', value: '25.00', evidence: { companyProfit: '999999.00' }, approvedBy: 'private-actor', employmentId: 'private-employment' }
  state.__statementRows = [{ paidAwards: [{ ...base, status: 'delivered' }], pendingAwards: [{ ...base, id: 'pending', status: 'approved' }], reversedAwards: [{ ...base, id: 'reversed', status: 'delivered', deliveryState: 'reversed' }] }]
  const data = await loadMyBenefitAwards(authz)
  assert.deepEqual(state.__statementQuery, { orgId: 'org', actorId: 'employee-login' })
  assert.equal(data.paidAwards.length, 1)
  assert.equal(data.pendingAwards.length, 1)
  assert.equal(data.reversedAwards.length, 1)
  assert.equal(data.reversedAwards[0]?.statusLabel, 'Reversed')
  assert.equal(data.paidAwards[0]?.programName, 'Recognition')
  assert.ok(!JSON.stringify(data).includes('999999'))
  assert.ok(!JSON.stringify(data).includes('private-actor'))
  assert.ok(!JSON.stringify(data).includes('private-employment'))
})

test('a computed ownership refusal reaches self-service with its remedy', async () => {
  state.__statementFailure = 'Ask an administrator to link your employment before viewing awards.'
  try {
    const data = await loadMyBenefitAwards(authz)
    assert.equal(data.awardsRefusal?.message, state.__statementFailure)
    assert.deepEqual(data.paidAwards, [])
    assert.deepEqual(data.pendingAwards, [])
  } finally { state.__statementFailure = undefined }
})
