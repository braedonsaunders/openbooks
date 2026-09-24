import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F4-8 (page half): the /admin/email page title and description were
// hardcoded English in the loader. They now resolve through the same
// admin.email catalog keys as the form, in the request locale.

const frAdmin = JSON.parse(
  readFileSync(new URL('../../../../messages/fr/admin.json', import.meta.url), 'utf8'),
) as Record<string, unknown>
const enAdmin = JSON.parse(
  readFileSync(new URL('../../../../messages/en/admin.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function lookup(tree: Record<string, unknown>, key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      return (node as Record<string, unknown>)[part]
    }
    return undefined
  }, tree)
  assert.equal(typeof value, 'string', `fr catalog must carry admin.${key}`)
  return value as string
}

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') return { shortCircuit: true, url: 'mock:email-page-intl' }
    if (specifier === '../../../../lib/authz') return { shortCircuit: true, url: 'mock:email-page-authz' }
    if (specifier === '@openbooks/engine/src/delivery/email-config.ts') {
      return { shortCircuit: true, url: 'mock:email-page-config' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:email-page-intl') {
      return {
        format: 'module',
        source: `const catalog = { admin: ${JSON.stringify(frAdmin)} };
          export async function getTranslations(namespace) {
            return (key) => {
              const value = String(namespace + '.' + key).split('.').reduce((node, part) => node?.[part], catalog);
              if (typeof value !== 'string') throw new Error('missing ' + namespace + '.' + key);
              return value;
            };
          }`,
        shortCircuit: true,
      }
    }
    if (url === 'mock:email-page-authz') {
      return {
        format: 'module',
        source: `export async function requirePermission() {
          return { user: { id: 'u1', orgId: 'o1' } };
        }`,
        shortCircuit: true,
      }
    }
    if (url === 'mock:email-page-config') {
      return {
        format: 'module',
        source: `export async function readOrgEmailConfigView() {
          return { hasSecret: false, updatedAt: null };
        }`,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const viewSpecifier: string = './view.ts?email-page-test'
const { loadEmailSettings } = (await import(viewSpecifier)) as typeof import('./view')
hooks.deregister()

test('the email page resolves its French title and description from the catalog', async () => {
  const data = await loadEmailSettings()
  assert.equal(data.title, lookup(frAdmin, 'email.title'))
  assert.equal(data.description, lookup(frAdmin, 'email.description'))
  assert.notEqual(data.title, (enAdmin.email as Record<string, string>).title)
  assert.notEqual(data.description, (enAdmin.email as Record<string, string>).description)
})
