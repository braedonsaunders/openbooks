import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
  return nextResolve(specifier, context)
} })
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { MASTER_BY_KEY, masterResource } = await import('./master-data-resources.ts')

for (const scenario of [
  { title: 'upsert previews one create and one update', mode: 'upsert' as const, invalid: false, custom: false, expected: [1, 1, 0] },
  { title: 'insert previews the second row refusal', mode: 'insert' as const, invalid: false, custom: false, expected: [1, 0, 1] },
  { title: 'a refused first row does not reserve its identity', mode: 'insert' as const, invalid: true, custom: false, expected: [1, 0, 1] },
  { title: 'a partial second row inherits required custom values from the first', mode: 'upsert' as const, invalid: false, custom: true, expected: [1, 1, 0] },
]) {
  test(`master preview: ${scenario.title}`, { skip: !env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypass(() => createScratchOrg())
    try {
      const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
      const customKey = `required_${randomUUID().replaceAll('-', '')}`
      if (scenario.custom) await withBypass(() => db.execute(sql`insert into custom_field_defs
        (org_id,target_table,key,label,field_type,config,is_required,sort_order,is_active)
        values (${org.orgId},'items',${customKey},'Required reference','text','{}'::jsonb,true,0,true)`))
      await withOrgContext(org.orgId, async () => {
        const resource = masterResource(MASTER_BY_KEY.get('items')!, org.orgId)
        const ctx = { orgId: org.orgId, actorId, allowedSubsidiaryIds: null }
        const rows = [
          { code: 'SAME', name: scenario.invalid ? '' : 'First', kind: 'service', ...(scenario.custom ? { [customKey]: 'retained' } : {}) },
          { code: 'SAME', name: 'Second', kind: 'service' },
        ]
        const before = (await db.execute<{ n: number }>(sql`select count(*)::int n from audit_log where org_id=${org.orgId}`)).rows[0]!.n
        const preview = await resource.write(rows, scenario.mode, { ...ctx, dryRun: true })
        assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int n from items where org_id=${org.orgId} and code='SAME'`)).rows[0]!.n, 0)
        assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int n from audit_log where org_id=${org.orgId}`)).rows[0]!.n, before)
        const committed = await resource.write(rows, scenario.mode, { ...ctx, dryRun: false })
        assert.deepEqual([preview.created, preview.updated, preview.failed], scenario.expected)
        assert.deepEqual(preview, committed)
        const stored = (await db.execute<{ name: string; custom: Record<string, string> }>(sql`select name,custom from items where org_id=${org.orgId} and code='SAME'`)).rows
        assert.equal(stored.length, 1)
        assert.equal(stored[0]!.name, scenario.mode === 'insert' && !scenario.invalid ? 'First' : 'Second')
        if (scenario.custom) assert.equal(stored[0]!.custom[customKey], 'retained')
        if (scenario.mode === 'insert' && !scenario.invalid) assert.match(preview.errors[0]!.message, /already exists \(code=SAME\)/)
      })
    } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
  })
}
