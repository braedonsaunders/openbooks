import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { loadEmploymentOptions, loadPeopleOptions } from './employment-read.ts'
import type { SqlExecutor } from '../platform/db.ts'

const orgId = randomUUID()
const actorId = randomUUID()
const selected = randomUUID()
const dialect = new PgDialect()
function runner() {
  const reads: { sql: string; params: unknown[] }[] = []
  const exec = { execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const compiled = dialect.sqlToQuery(query)
    if (compiled.sql.includes('from users')) return { rows: [{orgId,isSuperAdmin:true,isActive:true}] }
    reads.push(compiled)
    return { rows: [] }
  } } as unknown as SqlExecutor
  return {exec,reads}
}
function active(query: {sql:string;params:unknown[]}) {
  assert.match(query.sql, /p\.is_active/)
  assert.match(query.sql, /not exists \([\s\S]*from employee_roles r[\s\S]*r\.org_id = p\.org_id[\s\S]*r\.party_id = p\.id and not r\.is_active/)
  assert.ok(query.params.includes(orgId), 'option reads retain organization scope')
}

test('new employment choices filter both inactive people and retired employee roles', async () => {
  const {exec,reads} = runner()
  await loadEmploymentOptions(exec,{orgId,actorId})
  assert.equal(reads.length,1)
  active(reads[0]!)
})

test('active-only employment creation applies the same filter to the pinned selection', async () => {
  const {exec,reads} = runner()
  await loadEmploymentOptions(exec,{orgId,actorId,includeEmploymentId:selected,activeOnly:true})
  assert.equal(reads.length,2)
  reads.forEach(active)
  assert.ok(reads[1]!.params.includes(selected))
})

test('historical employment edits preserve the stored selection while browsing active choices', async () => {
  const {exec,reads} = runner()
  await loadEmploymentOptions(exec,{orgId,actorId,includeEmploymentId:selected})
  active(reads[0]!)
  assert.ok(!reads[1]!.sql.includes('p.is_active'))
  assert.ok(reads[1]!.params.includes(selected) && reads[1]!.params.includes(orgId))
})

test('interviewer choices share the active-worker policy including explicit active-only pins', async () => {
  const {exec,reads} = runner()
  await loadPeopleOptions(exec,{orgId,actorId,includePartyId:selected,activeOnly:true})
  assert.equal(reads.length,2)
  reads.forEach(active)
})
