import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { subsidiaryOptions } = await import('./subsidiaries')

/**
 * subsidiaryOptions feeds every subsidiary picker plus the consolidation
 * subtree resolver, and it carries no org parameter — the tenant boundary
 * must come from the ambient request context. Wherever RLS is off (the
 * local/test superuser role, pooled-scratch leftovers, any bypass reader)
 * an unscoped list silently grafts another tenant's entities into this
 * org's pickers and consolidation subtrees.
 */
test('subsidiaryOptions never lists another tenant under an org context', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await withBypass(() => createScratchOrg())
  const orgB = await withBypass(() => createScratchOrg())
  try {
    const intruder = `Intruder ${randomUUID()}`
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${randomUUID()}, ${orgB.orgId}, ${orgB.subsidiaryId}, ${intruder}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`)
    })
    const options = await withOrgContext(orgA.orgId, () => subsidiaryOptions())
    const names = options.map((o) => o.name)
    assert.ok(names.length > 0, 'expected org A to list its own subsidiaries')
    assert.ok(!names.includes(intruder), `org B subsidiary leaked into org A options: ${names.join(', ')}`)
    const orgOf = await withBypass(async () => db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgA.orgId}`))
    const own = new Set(orgOf.rows.map((r) => r.id))
    for (const o of options) assert.ok(own.has(o.id), `option ${o.id} (${o.name}) is not org A's`)
  } finally {
    await withBypass(() => dropScratchOrg(orgA.orgId))
    await withBypass(() => dropScratchOrg(orgB.orgId))
  }
})
