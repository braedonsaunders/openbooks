import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * Company Settings persists the vendor-bill release policy in org settings
 * JSON (default OFF), validates its shape, and audits the change. The Flows
 * engine and the Setup page both read the same key, so this is the single
 * source of truth — not a parallel gate.
 */
const root = pathToFileURL(process.cwd() + '/').href
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { readCompanySettings, updateCompanySettings } = await import('./company-settings')

async function orgSettings(orgId: string) {
  return withBypassContext(async () =>
    (await db.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id = ${orgId}`)).rows[0]!.settings,
  )
}

test('vendor-bill approval requirement defaults OFF and persists through Company Settings', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }

    const before = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal(before.status, 200)
    assert.equal((before.body.org as Record<string, unknown>).requireVendorBillApproval, false)

    const saved = await withBypassContext(() => updateCompanySettings(me, { requireVendorBillApproval: true }))
    assert.equal(saved.status, 200)
    assert.equal(((await orgSettings(org.orgId)).approvals as Record<string, unknown>).requireVendorBillApproval, true)
    const after = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal((after.body.org as Record<string, unknown>).requireVendorBillApproval, true)

    // Sibling settings keys survive the merge (no clobber).
    const settings = await orgSettings(org.orgId)
    assert.ok(settings.controlAccounts, 'control accounts survive the approvals write')

    // Reversible, and the reversal is audited with before/after state.
    const off = await withBypassContext(() => updateCompanySettings(me, { requireVendorBillApproval: false }))
    assert.equal(off.status, 200)
    assert.equal(((await orgSettings(org.orgId)).approvals as Record<string, unknown>).requireVendorBillApproval, false)
    const audits = await withBypassContext(async () =>
      (await db.execute<{ changes: Record<string, unknown> }>(sql`
        select changes from audit_log where org_id = ${org.orgId} and table_name = 'orgs' and action = 'update'`)).rows,
    )
    assert.ok(
      audits.some((row) => JSON.stringify(row.changes.requireVendorBillApproval) === '[false,true]'),
      `the ON flip is audited with before/after, got ${JSON.stringify(audits.map((row) => row.changes))}`,
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('vendor-bill approval requirement refuses non-boolean input', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    for (const bad of ['yes', 1, null, {}, []]) {
      const res = await withBypassContext(() => updateCompanySettings({ orgId: org.orgId, id: actor }, { requireVendorBillApproval: bad }))
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`)
    }
    assert.equal(((await orgSettings(org.orgId)).approvals as Record<string, unknown> | undefined)?.requireVendorBillApproval, undefined)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
