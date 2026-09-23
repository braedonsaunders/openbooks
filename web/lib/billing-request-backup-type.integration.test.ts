import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// An explicit backup type names one of the configured packet recipes. A
// misspelled type must refuse — silently persisting the default (or none)
// would issue the customer a packet nobody asked for, or no packet where
// the approver required one.
const root = pathToFileURL(process.cwd() + '/').href
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createBillingRequest } = await import('./billing-requests')
const DB = !!process.env.OPENBOOKS_DB_URL

async function setup() {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Billing requester', 'reviewer'))
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`))
  const project = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
    values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'BACKUP-TYPE', 'Backup type probe', ${org.customerId}, 'active', true)`))
  return { org, actor, project }
}

test('createBillingRequest refuses an unknown backup type', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    await assert.rejects(
      withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
        projectId: project,
        basis: 'draw_amount',
        drawAmount: '100',
        backupRequired: true,
        backupType: 'carrier_pigeon',
      })),
      /Unknown backup type "carrier_pigeon"/,
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('createBillingRequest persists a known backup type', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const created = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project,
      basis: 'draw_amount',
      drawAmount: '100',
      backupRequired: true,
      backupType: 'costed_timesheets',
    }))
    const row = (await withBypassContext(() => db.execute<{ backup_type: string }>(sql`
      select backup_type from billing_requests where id = ${created.id}`))).rows[0]
    assert.equal(row?.backup_type, 'costed_timesheets')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
