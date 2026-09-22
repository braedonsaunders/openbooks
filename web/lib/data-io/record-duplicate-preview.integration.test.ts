import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { FormSection } from '@openbooks/forms-core'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    return nextResolve(specifier, context)
  },
})
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { recordResource } = await import('./record-resources.ts')
const sections: FormSection[] = [{ id: 'main', title: 'Details', fields: [
  { id: 'title', label: 'Title', type: 'text', required: true },
] }]

for (const scenario of [
  { title: 'upsert classifies the second valid row as an update', mode: 'upsert' as const,
    rows: [{ record_number: 'SAME', title: 'First' }, { record_number: 'SAME', title: 'Second' }], expected: [1, 1, 0] },
  { title: 'insert refuses the second valid row by number', mode: 'insert' as const,
    rows: [{ record_number: 'SAME', title: 'First' }, { record_number: 'SAME', title: 'Second' }], expected: [1, 0, 1] },
  { title: 'an invalid first row does not reserve its number', mode: 'insert' as const,
    rows: [{ record_number: 'SAME', title: '' }, { record_number: 'SAME', title: 'Valid' }], expected: [1, 0, 1] },
  { title: 'anonymous rows remain independent creates', mode: 'insert' as const,
    rows: [{ record_number: '', title: 'First' }, { record_number: '', title: 'Second' }], expected: [2, 0, 0] },
]) {
  test(`record preview: ${scenario.title}`, { skip: !env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypass(() => createScratchOrg())
    try {
      const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
      const typeKey = `preview-${randomUUID().slice(0, 8)}`
      await withBypass(() => db.execute(sql`insert into custom_record_types
        (id,org_id,key,name,plural_name,fields,status,created_by,updated_by)
        values (${randomUUID()},${org.orgId},${typeKey},'Preview record','Preview records',
          ${JSON.stringify(sections)}::jsonb,'published',${actorId},${actorId})`))
      await withOrgContext(org.orgId, async () => {
        const resource = recordResource(org.orgId, typeKey, sections, 'Preview records')
        const ctx = { orgId: org.orgId, actorId, allowedSubsidiaryIds: null }
        const preview = await resource.write(scenario.rows, scenario.mode, { ...ctx, dryRun: true })
        assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int n from custom_records where org_id=${org.orgId}`)).rows[0]!.n, 0)
        const committed = await resource.write(scenario.rows, scenario.mode, { ...ctx, dryRun: false })
        assert.deepEqual([preview.created, preview.updated, preview.failed], scenario.expected)
        assert.deepEqual(preview, committed, 'preview and commit classify the same rows with the same refusals')
        const stored = (await db.execute<{ data: { title: string } }>(sql`select data from custom_records where org_id=${org.orgId}`)).rows
        assert.equal(stored.length, scenario.expected[0])
        if (scenario.mode === 'upsert') assert.equal(stored[0]!.data.title, 'Second')
        if (scenario.title.startsWith('insert refuses')) assert.match(preview.errors[0]!.message, /already exists \(record_number=SAME\)/)
        if (scenario.title.startsWith('an invalid')) assert.equal(preview.errors[0]!.row, 1)
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  })
}
