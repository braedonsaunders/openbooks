import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Member-drawer sessions must remount per session: FormDesigner seeds its
// field state in mount-only useState, so an edit-<id> session and the
// create-from-<source> duplicate opened after it must mount distinct
// instances — otherwise the copy inherits the org default checkbox (plus
// the old name/layout seed) and silently steals the default on save.
// Auth, gates, and the database are stubbed so the only thing under test
// is the loader's per-session drawer key.

const root = pathToFileURL(process.cwd() + '/').href
const stateKey = Symbol.for('openbooks.customization-duplicate-guard')
const state: { statements: unknown[] } = { statements: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(root + 'web/' + specifier.slice(2) + '.ts', context)
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-duplicate-db' }
    }
    if (specifier.endsWith('lib/authz')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-duplicate-authz' }
    }
    if (specifier.endsWith('lib/customization/gates')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-duplicate-gates' }
    }
    if (specifier.endsWith('lib/features')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-duplicate-features' }
    }
    if (specifier.endsWith('lib/feature-gates')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-duplicate-features' }
    }
    if (specifier.endsWith('lib/custom-fields')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-duplicate-fields' }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-duplicate-nav' }
    }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-duplicate-intl' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:customization-duplicate-db') {
      return {
        format: 'module',
        source: `
          const state = globalThis[Symbol.for('openbooks.customization-duplicate-guard')]
          export const db = {
            execute: async (query) => { state.statements.push(query); return { rows: [] } },
            transaction: async (fn) => fn({ execute: async (query) => { state.statements.push(query); return { rows: [] } } }),
          }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-duplicate-authz') {
      return {
        format: 'module',
        source: `
          export async function getAuthz() {
            return {
              user: { orgId: '00000000-0000-4000-8000-00000000a001', id: '00000000-0000-4000-8000-00000000a002' },
              permissions: new Set(['*']),
              allowedSubsidiaryIds: null,
            }
          }
          export function can() { return true }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-duplicate-gates') {
      return {
        format: 'module',
        source: `
          export async function refuseDisabledRecordType() { return null }
          export async function disabledRecordTypes() { return [] }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-duplicate-features') {
      return {
        format: 'module',
        source: `
          export async function isFeatureEnabled() { return true }
          export async function subsidiaryFeatureEnabled() { return true }
          export async function requireFeatureEnabled() {}
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-duplicate-fields') {
      return { format: 'module', source: 'export async function loadFieldDefs() { return [] }', shortCircuit: true }
    }
    if (url === 'mock:customization-duplicate-nav') {
      return {
        format: 'module',
        source: `
          export function redirect(url) { throw new Error('REDIRECT:' + url) }
          export function notFound() { throw new Error('NOT_FOUND') }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-duplicate-intl') {
      return {
        format: 'module',
        source: `
          export async function getTranslations() {
            const t = (key, vars) => vars ? key + ':' + JSON.stringify(vars) : key
            t.has = () => false
            return t
          }
        `,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const { loadCustomization } = await import('./view')

const SOURCE_ID = '019f68a5-6a24-78ec-bed6-cc04e06f2078'

/**
 * F-t10-002 — opening Duplicate after editing the org-default form carried
 * isDefault=true (plus the old name/layout seed) into the create session,
 * so the copy silently stole the org default on save. The drawer remounts
 * per session — edit-<id> vs create-from-<source> — so no session inherits
 * another's state.
 */
test('form drawer remounts per session so duplicate never inherits edit state', async () => {
  const edit = await loadCustomization({ recordType: 'vendor_bill', form: SOURCE_ID })
  const duplicate = await loadCustomization({ recordType: 'vendor_bill', form: 'new', from: SOURCE_ID })
  assert.equal(edit.formDrawerOpen, true)
  assert.equal(duplicate.formDrawerOpen, true)
  assert.equal(edit.formDrawerKey, `edit:${SOURCE_ID}`)
  assert.equal(duplicate.formDrawerKey, `new:${SOURCE_ID}`)
  assert.notEqual(edit.formDrawerKey, duplicate.formDrawerKey)
})
