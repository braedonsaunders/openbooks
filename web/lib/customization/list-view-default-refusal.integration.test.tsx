import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key)=>key}export async function getLocale(){return 'en'}" }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    // Authentication is the request boundary here; list resolution and its DB
    // data remain real. The property loader only needs the resolved principal.
    if (specifier === '../../../lib/authz') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function requirePermission(){return globalThis.__listDefaultAuthz}export function can(){return true}",
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { RecordListView } = await import('../../components/record-list-view.tsx')
const { EntityListView } = await import('../../components/entity-list-view.tsx')
const { loadPropertyManagement, propertyManagementSpec } = await import('../../app/(app)/property-management/view.ts')

installTrustedTestDatabaseBypass()
const DB = !!process.env.OPENBOOKS_DB_URL
const REMEDY = 'More than one default view is stored for this scope. Clear the extra default and save again.'

function statementText(query: { queryChunks?: unknown[] }): string {
  return (query.queryChunks ?? []).map((chunk) => {
    if (chunk && typeof chunk === 'object' && 'value' in chunk) {
      const value = (chunk as { value: unknown }).value
      return Array.isArray(value) ? value.join('') : ''
    }
    return ''
  }).join(' ')
}

test('record, entity and property lists show the named overlapping-default refusal', { skip: !DB }, async (t) => {
  const org = await withBypassContext(() => createScratchOrg())
  const originalExecute = db.execute.bind(db)
  let activeDefaults: Array<Record<string, unknown>> = []
  db.execute = ((query: { queryChunks?: unknown[] }) => {
    if (statementText(query).includes('from list_views')) return Promise.resolve({ rows: activeDefaults })
    return originalExecute(query as never)
  }) as unknown as typeof db.execute
  try {
    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'List view reviewer', 'reviewer'))
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
      await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({ features: { crm: true, inventory: true, propertyManagement: true } })}::jsonb where id=${org.orgId}`)
    })

    const setAmbiguousDefaults = (recordType: string) => {
      activeDefaults = ['First default', 'Second default'].map((name) => ({
        id: randomUUID(), name, recordType, scope: 'user', ownerId: userId,
        isDefault: true, isActive: true, config: {}, createdAt: new Date(), updatedAt: new Date(),
      }))
    }
    setAmbiguousDefaults('customer_invoice')
    const recordElement = await withOrgContext(org.orgId, () => RecordListView({
      recordType: 'customer_invoice', basePath: '/ar/invoices', orgId: org.orgId, userId,
      canManage: true, sp: {},
    }))
    setAmbiguousDefaults('customer')
    const entityElement = await withOrgContext(org.orgId, () => EntityListView({
      recordType: 'customer', orgId: org.orgId, userId, canManage: true, sp: {},
    }))
    const recordHtml = renderToStaticMarkup(recordElement)
    const entityHtml = renderToStaticMarkup(entityElement)
    assert.ok(recordHtml.includes(REMEDY), 'record lists render the named remedy in the in-page refusal')
    assert.ok(entityHtml.includes(REMEDY), 'entity lists render the named remedy in the in-page refusal')

    setAmbiguousDefaults('property')
    ;(globalThis as Record<string, unknown>).__listDefaultAuthz = {
      user: { orgId: org.orgId, id: userId, roles: [] },
      allowedSubsidiaryIds: null,
    }
    const propertyData = await withOrgContext(org.orgId, () => loadPropertyManagement({}))
    assert.equal(propertyData.listViewRefusal, REMEDY)
    assert.equal(propertyData.hasContent, false, 'ambiguous defaults do not load a success-shaped workspace')
    assert.equal(propertyData.customization.listView, null)

    const spec = propertyManagementSpec(propertyData)
    const emptyState = spec.body.find((block) => block.kind === 'widget' && block.widget === 'empty-state')
    assert.ok(emptyState && emptyState.kind === 'widget')
    assert.equal(emptyState.props?.description, REMEDY)
    assert.deepEqual(emptyState.when, { $: 'listViewRefusal' })
    const workspace = spec.body.find((block) => block.kind === 'widget' && block.widget === 'property-management-workspace')
    assert.ok(workspace && workspace.kind === 'widget')
    assert.deepEqual(workspace.when, { $: 'hasContent' })
    t.after(() => {
      delete (globalThis as Record<string, unknown>).__listDefaultAuthz
    })
  } finally {
    db.execute = originalExecute as typeof db.execute
    await dropScratchOrg(org.orgId)
  }
})
