import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) { if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }; return next(specifier, context) } })
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { seedAdoption } = await import('@openbooks/engine/src/payroll/filing-test-fixtures.ts')
const { dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { withPayRunReadSnapshot } = await import('./view')

test('payroll loader reads keep one repeatable snapshot across concurrent updates', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption())
  const original = (await withBypassContext(() => db.execute<{ name: string }>(sql`select name from orgs where id=${fx.orgId}`))).rows[0]!.name
  let readStarted!: () => void, writerFinished!: () => void
  const started = new Promise<void>((resolve) => { readStarted = resolve }), changed = new Promise<void>((resolve) => { writerFinished = resolve })
  try {
    const values = withPayRunReadSnapshot(fx.orgId, async () => {
      const before = (await db.execute<{ name: string }>(sql`select name from orgs where id=${fx.orgId}`)).rows[0]!.name
      readStarted(); await changed
      return [before, (await db.execute<{ name: string }>(sql`select name from orgs where id=${fx.orgId}`)).rows[0]!.name]
    })
    await started
    await withBypassContext(() => db.execute(sql`update orgs set name=${`Scratch snapshot update ${fx.orgId}`} where id=${fx.orgId}`).then(() => undefined))
    writerFinished()
    assert.deepEqual(await values, [original, original])
    assert.notEqual((await withBypassContext(() => db.execute<{ name: string }>(sql`select name from orgs where id=${fx.orgId}`))).rows[0]!.name, original)
  } finally { writerFinished(); await withBypassContext(() => dropScratchOrgReporting(fx.orgId)) }
})
