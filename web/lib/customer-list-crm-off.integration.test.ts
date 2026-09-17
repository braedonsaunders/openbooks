import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

// F-t11-001: /entities/customers crashes for orgs with CRM off. The list's
// status-facet query groups by the status expression, which is the constant
// 'customer' when CRM is off — `group by 'customer'` is a Postgres 42601, so
// the whole page throws. CRM-on orgs group by a real column and never notice.
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key)=>key}export async function getLocale(){return 'en'}" }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { EntityListView } = await import('../components/entity-list-view')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture(crm: boolean, action: (orgId: string, userId: string) => Promise<void>) {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'List reader', 'reviewer'))
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id = ${org.orgId} and key = 'reviewer'`)
      await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ features: { crm } })}::jsonb where id = ${org.orgId}`)
    })
    await action(org.orgId, userId)
  } finally {
    await dropScratchOrg(org.orgId)
  }
}

test('customer list renders with CRM off (constant status facet)', { skip: !DB }, async () => {
  await fixture(false, async (orgId, userId) => {
    const element = await withOrgContext(orgId, () => EntityListView({ recordType: 'customer', orgId, userId, canManage: true, sp: {} }))
    assert.ok(element, 'the list must render instead of throwing 42601')
  })
})

test('customer list still renders with CRM on (grouped status facet)', { skip: !DB }, async () => {
  await fixture(true, async (orgId, userId) => {
    const element = await withOrgContext(orgId, () => EntityListView({ recordType: 'customer', orgId, userId, canManage: true, sp: {} }))
    assert.ok(element, 'the list must render')
  })
})
