import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Header `party`/`gl_account` record fields resolve through the org-scoped
// RefResolver at import time (unknown ids fail the row), but repeating-row
// values arrive as raw JSON and are only shape-checked by
// validateRecordData — a file carrying another org's party/account uuid (or a
// dangling one) persists a cross-tenant pointer the HTTP write path refuses.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { getResource } = await import('./resources.ts')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)

test(
  'custom-record imports refuse repeating-row party references owned by another organization',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `reprow-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const { orgA, orgB, actorId } = await withBypass(async () => {
      const a = await createScratchOrg()
      const b = await createScratchOrg()
      const actor = (await seedFlowActors(a.orgId)).adminId
      const sections = [
        {
          id: 'main',
          title: 'Details',
          fields: [
            { id: 'vendor', type: 'party', label: 'Vendor' },
            { id: 'acct', type: 'gl_account', label: 'Account' },
          ],
        },
        {
          id: 'lines',
          title: 'Lines',
          repeating: true,
          fields: [{ id: 'billto', type: 'party', label: 'Bill to' }],
        },
      ]
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${randomUUID()}, ${a.orgId}, ${typeKey}, 'Repeating Refs', 'Repeating Refs',
           ${JSON.stringify(sections)}::jsonb, 'published', ${actor}, ${actor})
      `)
      return { orgA: a, orgB: b, actorId: actor }
    })

    try {
      await withOrgContext(orgA.orgId, async () => {
        const resource = await getResource(orgA.orgId, `record:${typeKey}`)
        assert.ok(resource)
        const ctx = { orgId: orgA.orgId, actorId, dryRun: false }

        // A repeating row pointing at another org's party must fail the row.
        const refused = await resource.write(
          [{
            vendor: orgA.vendorId,
            acct: orgA.accounts.bank,
            lines: JSON.stringify([{ billto: orgB.vendorId }]),
          }],
          'insert',
          ctx,
        )
        assert.equal(refused.failed, 1, `expected the row to fail, got ${JSON.stringify(refused)}`)
        assert.equal(refused.created, 0)
        assert.match(refused.errors[0]!.message, /not found/)
        const stored = await withBypass(() =>
          db.execute<{ n: number }>(sql`select count(*)::int as n from custom_records where org_id = ${orgA.orgId} and type_key = ${typeKey}`),
        )
        assert.equal(stored.rows[0]!.n, 0)

        // A repeating row pointing at an own-org party still imports.
        const accepted = await resource.write(
          [{
            vendor: orgA.vendorId,
            acct: orgA.accounts.bank,
            lines: JSON.stringify([{ billto: orgA.vendorId }]),
          }],
          'insert',
          ctx,
        )
        assert.equal(
          accepted.created,
          1,
          `expected 1 created, got ${JSON.stringify(accepted)}`,
        )
        const data = await withBypass(() =>
          db.execute<{ data: unknown }>(sql`select data from custom_records where org_id = ${orgA.orgId} and type_key = ${typeKey}`),
        )
        assert.equal(
          (data.rows[0]!.data as { lines: { billto: string }[] }).lines[0]!.billto,
          orgA.vendorId,
        )
      })
    } finally {
      await withBypass(() => dropScratchOrg(orgA.orgId))
      await withBypass(() => dropScratchOrg(orgB.orgId))
    }
  },
)
