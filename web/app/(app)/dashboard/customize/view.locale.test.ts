import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

const messages = (await import('../../../../messages/fr/dashboard.json', { with: { type: 'json' } })).default
Object.assign(globalThis, {
  __dashboardRoleLocaleState: {
    messages: { dashboard: messages },
    authz: { user: { roles: [{ key: 'admin' }] } },
  },
})

registerHooks({
  resolve(specifier, context, next) {
    const virtual = (source: string) => ({
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(source)}`,
    })
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') {
      return virtual(`
        export async function getTranslations(namespace) {
          return (key, values = {}) => {
            let message = globalThis.__dashboardRoleLocaleState.messages
            for (const part of [...namespace.split('.'), ...key.split('.')]) message = message[part]
            return message.replace(/\\{(\\w+)\\}/g, (_match, name) => String(values[name] ?? ('{' + name + '}')))
          }
        }
      `)
    }
    if (context.parentURL?.endsWith('/web/app/(app)/dashboard/customize/view.ts')) {
      if (specifier === '../../../../lib/authz') {
        return virtual('export async function getAuthz(){return globalThis.__dashboardRoleLocaleState.authz}')
      }
      if (specifier === '../_load-layout') {
        return virtual('export async function loadDashboardLayout(){return {role: "admin"}}')
      }
    }
    return next(specifier, context)
  },
})

const { loadCustomizeDashboard } = await import('./view')

test('dashboard role names in the customize caption use the viewer locale', async () => {
  const data = await loadCustomizeDashboard()
  assert.match(data?.roleLabel ?? '', /Administrateur/)
  assert.doesNotMatch(data?.roleLabel ?? '', /Administrator/)
})
