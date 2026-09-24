import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveAppModule } from '../../../../lib/test-module-hooks'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href

// H-CRMQUOTA: quotas name an owner or team but carry no subsidiary lineage,
// so a subsidiary-restricted caller must neither read them (hidden with a
// notice, mirroring the forecast reader) nor write them (named 403, no
// row). Real route, real database, real role restriction; only the session
// identity is scripted.

const dir = dirname(fileURLToPath(import.meta.url))
const messagesRoot = join(dir, '..', '..', '..', '..', 'messages')
const crmEn = JSON.parse(readFileSync(join(messagesRoot, 'en', 'crm.json'), 'utf8'))

const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __crmSetupQuotaScope: session })

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
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function currentUser(){return globalThis.__crmSetupQuotaScope.user}',
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
const { GET, POST } = await import('./route.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

function asUser(user: SessionUser | null): void {
  session.user = user
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  const owner = await withBypassContext(() => createScratchUser(org.orgId, 'Quota owner', 'quota_owner'))
  const scoped = await withBypassContext(() => createScratchUser(org.orgId, 'Scoped setup', 'scoped_setup'))
  let secondSub = ''
  await withBypassContext(async () => {
    await db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`,
    )
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='quota_owner'`)
    // A second legal entity: the quota names neither, which is the leak.
    const inserted = await db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)
    secondSub = inserted.rows[0]!.id
    // The restricted role may manage setup but sees only the second entity.
    await db.execute(sql`
      update app_roles set permissions='["crm.setup.manage"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [secondSub] })}::jsonb
       where org_id=${org.orgId} and key='scoped_setup'`)
    await db.execute(sql`
      insert into crm_sales_quotas (org_id, owner_user_id, sales_team_id, period_start, period_end, currency, amount, filters, created_by, updated_by)
      values (${org.orgId}, ${owner}, null, '2026-07-01', '2026-07-31', 'CAD', '50000', '{}'::jsonb, ${owner}, ${owner})`)
  })
  const ownerUser: SessionUser = {
    id: owner, orgId: org.orgId, name: 'Quota owner', email: 'owner@scratch.test',
    roles: [], isSuperAdmin: false, envKind: 'production',
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: owner,
  }
  const scopedUser: SessionUser = {
    id: scoped, orgId: org.orgId, name: 'Scoped setup', email: 'scoped@scratch.test',
    roles: [], isSuperAdmin: false, envKind: 'production',
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: scoped,
  }
  await withOrgContext(org.orgId, () => ensureCrmDefaults(org.orgId, owner))
  const quotaCount = async (): Promise<number> =>
    Number(
      (
        await db.execute<{ n: string }>(
          sql`select count(*) as n from crm_sales_quotas where org_id=${org.orgId}`,
        )
      ).rows[0]!.n,
    )
  const close = async (): Promise<void> => {
    asUser(null)
    await dropScratchOrg(org.orgId)
  }
  return { org, ownerUser, scopedUser, quotaCount, close }
}

function postQuota(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://audit.local/api/crm/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  )
}

test('a subsidiary-restricted caller reads no quotas but keeps the rest of setup', { skip: !DB }, async () => {
  const { org, scopedUser, close } = await fixture()
  try {
    asUser(scopedUser)
    const response = await withOrgContext(org.orgId, () => GET())
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.quotas, [])
    assert.equal(body.quotasNotice, crmEn.forecasts.quotasRestrictedNotice)
    assert.ok(Array.isArray(body.teams), 'non-quota setup stays readable')
  } finally {
    await close()
  }
})

test('an unrestricted caller still reads quotas with no notice', { skip: !DB }, async () => {
  const { org, ownerUser, close } = await fixture()
  try {
    asUser(ownerUser)
    const response = await withOrgContext(org.orgId, () => GET())
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.quotas.length, 1)
    assert.equal(body.quotasNotice, null)
  } finally {
    await close()
  }
})

test('a subsidiary-restricted caller cannot save a quota for any owner', { skip: !DB }, async () => {
  const { org, ownerUser, scopedUser, quotaCount, close } = await fixture()
  try {
    asUser(scopedUser)
    const before = await quotaCount()
    const response = await withOrgContext(org.orgId, () =>
      postQuota({
        action: 'save-quota',
        ownerUserId: ownerUser.id,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        amount: '1000',
      }),
    )
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'requires unrestricted subsidiary access' })
    assert.equal(await quotaCount(), before, 'the refused write stored nothing')
  } finally {
    await close()
  }
})

test('an unrestricted caller can still save a quota', { skip: !DB }, async () => {
  const { org, ownerUser, quotaCount, close } = await fixture()
  try {
    asUser(ownerUser)
    const before = await quotaCount()
    const response = await withOrgContext(org.orgId, () =>
      postQuota({
        action: 'save-quota',
        ownerUserId: ownerUser.id,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        amount: '1000',
      }),
    )
    assert.equal(response.status, 200)
    assert.equal(await quotaCount(), before + 1)
  } finally {
    await close()
  }
})
