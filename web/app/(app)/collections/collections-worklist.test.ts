import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const state = { canReadAr: true }
Object.assign(globalThis, { __collectionsWorklistState: state })
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: 'export function redirect(path){throw new Error(`redirect:${path}`)}' })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(`
          export async function getTranslations(namespace){
            return (key) => namespace === 'nav' && key === 'modules.collections' ? 'Collections'
              : namespace === 'ar' && key === 'collections.pageDescription' ? 'Collect receivables and manage billing.'
              : namespace === 'ar' && key === 'collections.worklistCta' ? 'Open overdue worklist'
              : key;
          }
        `),
      }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent('export const db={execute:async()=>({rows:[]})}'),
      }
    }
    if (specifier === '../../../lib/authz' && context.parentURL?.endsWith('/web/app/(app)/collections/view.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(`
          export async function requirePermission(){return {user:{orgId:'org-1'}}}
          export function can(){return globalThis.__collectionsWorklistState.canReadAr}
        `),
      }
    }
    if (specifier === '../../../lib/features' && context.parentURL?.endsWith('/web/app/(app)/collections/view.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function isFeatureEnabled(){return false}' }
    }
    if (specifier === '../../../lib/custom-reports' && context.parentURL?.endsWith('/web/app/(app)/collections/view.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function builtInReportDefinitionId(){return null}' }
    }
    return next(specifier, context)
  },
})

const { loadCollections, collectionsSpec } = await import('./view')

function fieldPath(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !("$" in value)) return undefined
  return typeof value.$ === 'string' ? value.$ : undefined
}

test('collections loader gates its worklist independently of configuration', async () => {
  state.canReadAr = true
  const accessible = await loadCollections()
  assert.equal(accessible.description, 'Collect receivables and manage billing.')
  assert.equal(accessible.worklistHref, '/ar')
  assert.equal(accessible.worklistLabel, 'Open overdue worklist')

  state.canReadAr = false
  const restricted = await loadCollections()
  assert.equal(restricted.description, 'Collect receivables and manage billing.')
  assert.equal(restricted.worklistHref, null)
})

test('collections page spec carries the loader copy and worklist into its shell', async () => {
  const data = await loadCollections()
  const spec = collectionsSpec(data)
  const shell = spec.body.find((block) => block.kind === 'widget' && block.widget === 'collections-shell')
  assert.ok(shell && shell.kind === 'widget')
  assert.equal(fieldPath(shell.props?.description), 'description')
  assert.equal(fieldPath(shell.props?.worklistHref), 'worklistHref')
  assert.equal(fieldPath(shell.props?.worklistLabel), 'worklistLabel')
})
