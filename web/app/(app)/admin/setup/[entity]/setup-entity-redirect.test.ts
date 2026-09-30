import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Rehomed and unknown setup entities have no standalone page.
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === 'next/navigation') {
      return { shortCircuit: true, format: 'module', url: 'mock:navigation' }
    }
    if (
      specifier === '../../../../../lib/authz' &&
      (context.parentURL?.endsWith('/admin/setup/[entity]/view.ts') ||
        context.parentURL?.endsWith('/admin/setup/%5Bentity%5D/view.ts'))
    ) {
      return { shortCircuit: true, format: 'module', url: 'mock:authz' }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'mock:navigation') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          export function redirect(href) { throw { digest: 'NEXT_REDIRECT', href } }
          export function notFound() { throw { digest: 'NEXT_NOT_FOUND' } }
        `,
      }
    }
    if (url === 'mock:authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          export async function requirePermission() {
            return { user: { orgId: 'org-setup', id: 'actor-setup' }, permissions: ['admin.setup.manage'], allowedSubsidiaryIds: null }
          }
          export function can() { return true }
        `,
      }
    }
    return next(url, context)
  },
})

const { loadSetupEntity } = await import('./view.ts')

test('rehomed and unknown setup keys refuse standalone pages', async () => {
  for (const key of ['hrm-action-reasons', 'tax-regimes', 'pay-schedules', 'no-such-entity']) {
    await assert.rejects(loadSetupEntity(key, {}), (error: unknown) =>
      (error as { digest?: string }).digest === 'NEXT_NOT_FOUND', key)
  }
})
