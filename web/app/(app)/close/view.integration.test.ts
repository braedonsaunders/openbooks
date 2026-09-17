import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: 'actor' }
Object.assign(globalThis, { __closeListState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
// Resolve the real English close messages so lock-detail assertions read the
// actual user-visible string, not the message key. Only simple {var}
// interpolation is supported — enough for the list branch (no plurals there).
const closeMessages = JSON.parse(readFileSync(new URL('../../../messages/en/close.json', import.meta.url), 'utf8'))
const translationsMock = `
  const MESSAGES = ${JSON.stringify({ close: closeMessages })};
  export async function getTranslations(ns) {
    return (key, params) => {
      let msg = MESSAGES;
      for (const part of String(ns ? ns + '.' + key : key).split('.')) msg = msg == null ? msg : msg[part];
      if (typeof msg !== 'string') return key;
      return msg.replace(/\\{(\\w+)\\}/g, (m, name) => (params != null && params[name] !== undefined ? String(params[name]) : m));
    };
  }
`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual(`export function notFound() { throw new Error('notFound') }`)
    if (specifier === 'next-intl/server') return virtual(translationsMock)
    if (specifier === '@braedonsaunders/appkit-viewspec') return virtual(`
      export const badge = () => ({});
      export const column = () => ({});
      export const field = {};
      export const grid = () => ({});
      export const page = () => ({});
      export const pageHeader = () => ({});
      export const pagination = () => ({});
      export const ref = () => () => ({});
      export const rootRef = () => () => ({});
      export const table = () => ({});
      export const text = () => ({});
      export const widget = () => ({});
      export const widgetBlock = () => ({});
      export const widgetCell = () => ({});
    `)
    if (specifier === '../../../lib/close-scope') return virtual(`
      export function guardCloseScope() { return null }
    `)
    if (specifier === '../../../lib/authz') return virtual(`
      export async function requirePermission() {
        const s = globalThis.__closeListState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
      export function can() { return true }
    `)
    if (specifier === '../../../lib/feature-gates') return virtual(`
      export async function requireFeatureEnabled() { return undefined }
    `)
    if (specifier === '../../../lib/fiscal') return virtual(`
      export async function currentFiscalYear() { return 2026 }
    `)
    if (specifier === '../../../lib/features') return virtual(`
      export async function subsidiaryFeatureEnabled() { return false }
      export async function resolvedFeatureState() { return {} }
      export function featureEnabled() { return false }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
const { setPeriodLockState } = await import('@openbooks/engine/src/close.ts')
const { loadClose } = await import('./view.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

test('close list falls back to the current fiscal year for a malformed fy filter', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    const baseline = await loadClose({})
    assert.ok(baseline.rows.length > 0, 'scratch org has periods in the current fiscal year')
    // A hand-edited ?fy=abc (or fractional/overflowing year) must not 500 on
    // a database cast error: it falls back exactly like an absent filter.
    for (const fy of ['abc', '2026.5', '1e21']) {
      const view = await loadClose({ fy })
      assert.deepEqual(
        view.rows.map((row) => row.id).sort(),
        baseline.rows.map((row) => row.id).sort(),
        `?fy=${fy} falls back to the current fiscal year`,
      )
      assert.equal(view.total, baseline.total)
    }
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('close list names the locked modules and book for a period locked outside any run (F-t02-005)', { skip: !DB }, async () => {
  // t02/Summit Ridge: autopilot period_locks closed AR for October while the
  // /close list read only close_runs — every period showed "Not started" and
  // the 422 had no visible basis. The list must name exactly which
  // module/book/period is locked.
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    const actorId = (await seedFlowActors(org.orgId)).adminId
    for (const module of ['ar', 'gl'] as const) {
      await setPeriodLockState({
        orgId: org.orgId, periodId: org.periodId, bookId: org.bookId,
        module, state: 'closed', actorId, reason: 'F-t02-005 diagnosis',
      })
    }
    const view = await loadClose({})
    const row = view.rows.find((r) => r.id === org.periodId)
    assert.ok(row, 'the locked period is listed')
    assert.equal(row.lockLabel, 'AR, GL locked · Primary')
    // An unlocked period carries no lock detail.
    for (const other of view.rows.filter((r) => r.id !== org.periodId)) {
      assert.equal(other.lockLabel, null)
    }
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
