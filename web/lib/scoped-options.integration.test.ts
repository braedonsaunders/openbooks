import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, _context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, _context)
} })

const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { listScopedAccountOptions } = await import('./scoped-options')

test('account option reader includes only accounts assigned to the caller subsidiaries', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const otherSubsidiary = randomUUID()
      const visibleAccount = randomUUID()
      const hiddenAccount = randomUUID()
      const sharedAccount = randomUUID()
      await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${otherSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Other legal entity', 'CAD', 'CA')`)
      await db.execute(sql`insert into accounts(id, org_id, number, name, type, subsidiary_id, is_active, is_summary)
        values (${visibleAccount}, ${org.orgId}, '93001', 'Visible clearing', 'expense', ${org.subsidiaryId}, true, false),
               (${hiddenAccount}, ${org.orgId}, '93002', 'Hidden clearing', 'expense', ${otherSubsidiary}, true, false),
               (${sharedAccount}, ${org.orgId}, '93003', 'Shared clearing', 'expense', null, true, false)`)

      const restricted = await listScopedAccountOptions(org.orgId, new Set([org.subsidiaryId]), { activeOnly: true, postingOnly: true })
      const unrestricted = await listScopedAccountOptions(org.orgId, null, { activeOnly: true, postingOnly: true })
      assert.ok(restricted.some((account) => account.id === visibleAccount))
      const hiddenIds = new Set<string>([hiddenAccount, sharedAccount])
      assert.ok(!restricted.some((account) => hiddenIds.has(account.id)))
      assert.ok(unrestricted.some((account) => account.id === hiddenAccount))
      assert.ok(unrestricted.some((account) => account.id === sharedAccount))
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
