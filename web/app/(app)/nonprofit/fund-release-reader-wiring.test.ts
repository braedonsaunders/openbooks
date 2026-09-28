import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { stubModules } from '../../../testing/stub-modules'
import { resolveAppModule } from '../../../lib/test-module-hooks'
import type { FundReadRecord } from '@openbooks/engine/src/nonprofit/funds.ts'
import type { FundReleaseReadRecord } from '@openbooks/engine/src/nonprofit/releases.ts'

const root = pathToFileURL(process.cwd() + '/').href
const orgId = '00000000-0000-4000-8000-000000000001'
const recordId = '00000000-0000-4000-8000-000000000002'
const state = {
  reads: [] as Array<Record<string, string>>,
  fund: null as FundReadRecord | null,
  release: null as FundReleaseReadRecord | null,
  collections: 0,
}
Object.assign(globalThis, { __fundReaderBoundary: state })
registerHooks({
  resolve(s, c, next) {
    const wrap = (path: string, source: string) => ({ shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(root + path)};${source}`) })
    if (s === '../../../../lib/authz') return wrap('web/lib/authz.ts', `export async function requirePermission(){return {user:{orgId:${JSON.stringify(orgId)}},permissions:new Set(['funds.read']),allowedSubsidiaryIds:null}}`)
    if (s.endsWith('/features') || s === './features') return wrap('web/lib/features.ts', `export async function isFeatureEnabled(){return true} export async function orgFeatureState(){return {features:{nonprofit:true,fundAccounting:true}}}`)
    if (s === '@openbooks/engine/src/nonprofit/funds.ts' && c.parentURL?.endsWith('/funds/view.ts')) return wrap('engine/src/nonprofit/funds.ts', `export async function getFund(request){const s=globalThis.__fundReaderBoundary;s.reads.push(request);return s.fund}`)
    if (s === '@openbooks/engine/src/nonprofit/releases.ts' && c.parentURL?.endsWith('/releases/view.ts')) return wrap('engine/src/nonprofit/releases.ts', `export async function getFundRelease(request){const s=globalThis.__fundReaderBoundary;s.reads.push(request);return s.release}`)
    if (s === '@openbooks/engine/src/platform/db.ts' && c.parentURL?.endsWith('/funds/view.ts')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export const db={async execute(){const s=globalThis.__fundReaderBoundary;if(!s.fund || s.reads.length!==1)throw Error('collection read before canonical fund');s.collections++;return {rows:[]}}}`) }
    return resolveAppModule(s, c, next, root) ?? next(s, c)
  },
})
stubModules({ intl: true, navigation: true })
const { loadFunds } = await import('./funds/view.ts')
const { loadReleases } = await import('./releases/view.ts')

test('fund and release drawers use tenant-scoped canonical readers and refuse missing records', async () => {
  for (const [load, key, idKey] of [[loadFunds, 'fund', 'fundId'], [loadReleases, 'release', 'releaseId']] as const) {
    state.reads = []
    state.collections = 0
    for (const params of [{}, { [key]: 'malformed' }]) assert.equal((await load(params)).drawer, null)
    assert.deepEqual(state.reads, [], 'absent and malformed links do not read records')
    await assert.rejects(load({ [key]: recordId, orgId: 'foreign-org' }), /NOT_FOUND/)
    assert.deepEqual(state.reads, [{ orgId, [idKey]: recordId }])
    assert.equal(state.collections, 0, 'a refused canonical read never reaches drawer collections')
  }
  state.fund = { id: recordId, code: 'RESTRICTED', name: 'Restricted fund', kind: 'restricted', restrictionClass: 'donor', budgetaryControl: 'hard', isActive: true, parentId: null, subsidiaryId: null, subsidiaryIncludeChildren: false, custom: {} }
  state.reads = []
  const fund = (await loadFunds({ fund: recordId })).drawer
  assert.ok(fund)
  assert.deepEqual(state.reads, [{ orgId, fundId: recordId }])
  assert.equal(state.collections, 2)
  assert.equal(fund.fund.budgetaryControl, 'hard')
  assert.equal(fund.fund.restrictionClass, 'donor')
  assert.equal(fund.canManage, false)
  assert.equal(fund.closeHref, '/nonprofit/funds')
  state.release = { id: recordId, number: 'REL-1', releaseDate: '2026-01-01', amount: '12.34', purpose: 'Scholarship', satisfactionRef: 'Award', status: 'draft', fromFundId: recordId, toFundId: recordId, releaseAccountId: recordId, submittedBy: null, submittedAt: null, flowRunId: null, fromCode: null, fromName: 'Restricted fund', toCode: 'OPERATING', toName: 'Operating fund', postedEntryId: null, voidEntryId: null, custom: {} }
  state.reads = []
  const release = (await loadReleases({ release: recordId })).drawer
  assert.ok(release)
  assert.deepEqual(state.reads, [{ orgId, releaseId: recordId }])
  assert.equal(release.release.amount, '12.34')
  assert.equal(release.release.fromCode, 'Restricted fund')
  assert.equal(release.release.toCode, 'OPERATING')
  assert.equal(release.canManage, false)
  assert.equal(release.closeHref, '/nonprofit/releases')
})
