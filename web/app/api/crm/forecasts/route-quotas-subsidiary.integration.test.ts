import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveAppModule } from '../../../../lib/test-module-hooks'

const root = pathToFileURL(process.cwd() + '/').href

// C1: quotas carry no subsidiary lineage, so a subsidiary-restricted caller
// must receive none of them — a quota for an owner or team whose
// opportunities sit in another entity would otherwise leak across the
// boundary. Real route, real database; only the gate is scripted.

const dir = dirname(fileURLToPath(import.meta.url))
const messagesRoot = join(dir, '..', '..', '..', '..', 'messages')
const crmEn = JSON.parse(readFileSync(join(messagesRoot, 'en', 'crm.json'), 'utf8'))

const state: { orgId: string; actorId: string; allowed: string[] | null } = {
  orgId: '',
  actorId: '',
  allowed: null,
}
Object.assign(globalThis, { __quotaGateState: state })

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      const crmUrl = pathToFileURL(join(messagesRoot, 'en', 'crm.json')).href
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            `import crm from ${JSON.stringify(crmUrl)} with { type: 'json' };
             const bundles = { crm };
             function walk(ns, key) {
               const parts = String(ns).split('.').concat(String(key).split('.'));
               let node = bundles;
               for (const part of parts) node = node?.[part];
               if (typeof node !== 'string') throw new Error('MISSING_MESSAGE:' + ns + '.' + key);
               return node;
             }
             export async function getTranslations(ns) { return (key) => walk(ns, key); }`,
          ),
      }
    }
    if (specifier.endsWith('/lib/authz')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function guardPermission(){return {}};export function can(){return true}',
      }
    }
    if (specifier.endsWith('/lib/feature-gates')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function guardFeaturePermission(){const s=globalThis.__quotaGateState;return {user:{id:s.actorId,orgId:s.orgId},allowedSubsidiaryIds:s.allowed===null?null:new Set(s.allowed)}}',
      }
    }
    const app = resolveAppModule(specifier, context, next, root)
    if (app) return app
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { randomUUID } = await import('node:crypto')
const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm/crm.ts')
const { GET } = await import('./route.ts')
const { NextRequest } = await import('next/server')

const DB = !!process.env.OPENBOOKS_DB_URL
const PERIOD = 'periodStart=2026-07-01&periodEnd=2026-07-31'

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Quota owner', 'owner'))
  await withBypassContext(async () => {
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='owner'`)
    await db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`,
    )
    // A second legal entity: quotas name neither, which is the leak.
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1`)
    await db.execute(sql`
      insert into crm_sales_quotas (org_id, owner_user_id, sales_team_id, period_start, period_end, currency, amount, filters, created_by, updated_by)
      values (${org.orgId}, ${actor}, null, '2026-07-01', '2026-07-31', 'CAD', '50000', '{}'::jsonb, ${actor}, ${actor})`)
  })
  state.orgId = org.orgId
  state.actorId = actor
  await withOrgContext(org.orgId, () => ensureCrmDefaults(org.orgId, actor))
  return org
}

test('a subsidiary-restricted caller gets no quotas and a named notice', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const second = (
      await db.execute<{ id: string }>(
        sql`select id from subsidiaries where org_id=${org.orgId} and name='Second Co'`,
      )
    ).rows[0]!.id
    state.allowed = [second]
    const response = await GET(new NextRequest(`http://audit.local?${PERIOD}`))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.quotas, [])
    assert.equal(body.quotasNotice, crmEn.forecasts.quotasRestrictedNotice)
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})

test('an unrestricted caller still receives quotas with no notice', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    state.allowed = null
    const response = await GET(new NextRequest(`http://audit.local?${PERIOD}`))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.quotas.length, 1)
    assert.equal(body.quotasNotice, null)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
