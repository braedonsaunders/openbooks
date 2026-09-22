import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { FormSection } from '@openbooks/forms-core'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    return nextResolve(specifier, context)
  },
})
const { getResource } = await import('./resources.ts')
const { toCsv } = await import('./serialize.ts')
const { parseImportFile } = await import('./parse.ts')
hooks.deregister()
const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const DB = !!process.env.OPENBOOKS_DB_URL
const sections: FormSection[] = [
  { id: 'main', title: 'Main', fields: [
    { id: 'external_id', type: 'text', label: 'External ID' },
    { id: 'amount', type: 'currency', label: 'Amount' },
    { id: 'quantity', type: 'number', label: 'Quantity' },
    { id: 'percent', type: 'percentage', label: 'Percent' },
    { id: 'rating', type: 'rating', label: 'Rating' },
  ] },
  { id: 'lines', title: 'Lines', repeating: true, fields: [
    { id: 'line_amount', type: 'currency', label: 'Line amount' },
    { id: 'code', type: 'text', label: 'Code' },
  ] },
]

async function fixture() {
  const org = await createScratchOrg()
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId
    const typeKey = `numbers-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.execute(sql`insert into custom_record_types
      (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${typeKey}, 'Measurement', 'Measurements',
        ${JSON.stringify(sections)}::jsonb, 'published', ${actorId}, ${actorId})`)
    const resource = await getResource(org.orgId, `record:${typeKey}`)
    assert.ok(resource)
    const live = { orgId: org.orgId, actorId, dryRun: false, allowedSubsidiaryIds: null }
    const stored = async () => (await db.execute<{ data: Record<string, unknown> }>(sql`
      select data from custom_records where org_id=${org.orgId} and type_key=${typeKey} order by record_number`)).rows.map(r => r.data)
    const auditCount = async () => (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from audit_log where org_id=${org.orgId} and table_name='custom_records'`)).rows[0]!.n
    return { org, resource, live, stored, auditCount }
  } catch (error) {
    await dropScratchOrg(org.orgId)
    throw error
  }
}

test('custom-record export reimports unchanged through CSV, including small numeric values and repeated amounts', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const value = { external_id: '00123', amount: 42.25, quantity: 1e-7, percent: 12.5, rating: 3, lines: [{ line_amount: 10.5, code: '0007' }] }
    assert.equal((await f.resource.write([value], 'insert', f.live)).created, 1)
    const before = await f.stored()
    const exported = await f.resource.read({ allowedSubsidiaryIds: null })
    const parsed = await parseImportFile('csv', { text: toCsv('Measurements', exported.columns, exported.rows) })
    for (const dryRun of [true, false]) {
      const result = await f.resource.write(parsed.rows, 'upsert', { ...f.live, dryRun })
      assert.equal(result.failed, 0, JSON.stringify(result.errors))
      assert.equal(result.updated, 1)
    }
    assert.deepEqual(await f.stored(), before)
  } finally { await dropScratchOrg(f.org.orgId) }
})

test('decimal strings obey field types and preserve zero, negatives, leading zeros and tiny decimals', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const result = await f.resource.write([{ external_id: '00123', amount: '-12.500', quantity: '0.00000000000000000001', percent: '0', rating: '3', lines: '[{"line_amount":"123.45","code":"007"}]' }], 'insert', f.live)
    assert.equal(result.failed, 0, JSON.stringify(result.errors))
    assert.deepEqual(await f.stored(), [{ external_id: '00123', amount: -12.5, quantity: 1e-20, percent: 0, rating: 3, lines: [{ line_amount: 123.45, code: '007' }] }])
  } finally { await dropScratchOrg(f.org.orgId) }
})

test('precision loss and ambiguous separators refuse in preview and commit without records or audit', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    for (const [value, refusal] of [['123456.789012345678', /without changing its value.*text field/], ['0.10000000000000001', /without changing its value/], ['1,234', /ambiguous/]] as const) {
      const before = await f.auditCount()
      for (const dryRun of [true, false]) {
        const result = await f.resource.write([{ amount: value }], 'insert', { ...f.live, dryRun })
        assert.equal(result.failed, 1, `accepted ${value}`)
        assert.match(result.errors[0]!.message, refusal)
      }
      assert.deepEqual(await f.stored(), [])
      assert.equal(await f.auditCount(), before)
    }
  } finally { await dropScratchOrg(f.org.orgId) }
})

test('unquoted repeating JSON decimals retain source precision until validation', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const before = await f.auditCount()
    for (const dryRun of [true, false]) {
      const result = await f.resource.write([{ amount: 1.25, lines: '[{"line_amount":123456.789012345678}]' }], 'insert', { ...f.live, dryRun })
      assert.equal(result.failed, 1, 'repeating JSON rounded before numeric validation')
      assert.match(result.errors[0]!.message, /Line amount.*without changing its value/)
    }
    assert.deepEqual(await f.stored(), [])
    assert.equal(await f.auditCount(), before)
    const good = await f.resource.write([{ amount: 1.25, lines: '[{"line_amount":10.5}]' }], 'insert', f.live)
    assert.equal(good.created, 1, JSON.stringify(good.errors))
  } finally { await dropScratchOrg(f.org.orgId) }
})

test('schema bounds still refuse numeric strings and optional blank fields remain absent', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    for (const row of [{ rating: '6' }, { amount: '1000000001' }]) {
      const result = await f.resource.write([row], 'insert', f.live)
      assert.equal(result.failed, 1, JSON.stringify(row))
    }
    assert.deepEqual(await f.stored(), [])
    const blank = await f.resource.write([{ external_id: 'blank', amount: '', quantity: null }], 'insert', f.live)
    assert.equal(blank.created, 1, JSON.stringify(blank.errors))
    assert.deepEqual(await f.stored(), [{ external_id: 'blank', lines: [] }])
  } finally { await dropScratchOrg(f.org.orgId) }
})
