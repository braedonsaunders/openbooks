import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: 'actor' }
Object.assign(globalThis, { __closeListState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual(`export function notFound() { throw new Error('notFound') }`)
    if (specifier === 'next-intl/server') return virtual(`export async function getTranslations() { return (key) => key }`)
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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
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
