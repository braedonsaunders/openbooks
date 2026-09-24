import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F4T-18 behaviour coverage (unit partition, module doubles, no database):
// a bookmarked /admin/setup/<key> for a rehomed entity redirects to the
// home the registry records, carrying the ?movedFrom notice; an unknown
// key still 404s. Authz is a fabricated manager — permission logic itself
// is proven by the scope suite, not doubled here.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
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

async function redirectHref(key: string, sp: Record<string, string | string[] | undefined> = {}): Promise<string> {
  try {
    await loadSetupEntity(key, sp)
  } catch (error) {
    if ((error as { digest?: string }).digest === 'NEXT_REDIRECT') {
      return (error as { href: string }).href
    }
    throw error
  }
  throw new Error(`${key} did not redirect`)
}

test('a rehomed key redirects to its registry home with the notice', async () => {
  assert.equal(
    await redirectHref('hrm-action-reasons'),
    '/hrm/change-requests?reasons=1&movedFrom=setup-entity',
  )
  assert.equal(
    await redirectHref('tax-regimes'),
    '/admin/setup/tax-depreciation?tab=regimes&movedFrom=setup-entity',
  )
})

test('the redirect keeps reader params with the home address winning', async () => {
  const href = await redirectHref('pay-schedules', { q: 'weekly' })
  assert.equal(href, '/admin/setup/payroll?q=weekly&tab=schedules&movedFrom=setup-entity')
})

test('an unknown key still 404s', async () => {
  try {
    await loadSetupEntity('no-such-entity', {})
  } catch (error) {
    assert.equal((error as { digest?: string }).digest, 'NEXT_NOT_FOUND')
    return
  }
  throw new Error('an unknown setup key did not 404')
})
