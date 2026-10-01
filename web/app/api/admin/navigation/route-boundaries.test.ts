import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { PgDialect } from 'drizzle-orm/pg-core'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type { OrgNavConfig } from '../../../../lib/nav/registry'

const guardKey = Symbol.for('openbooks.navigation.boundary.guard')
const session = { user: { id: 'editor-one', orgId: 'company-one' }, permissions: new Set(['admin.nav.manage']), allowedSubsidiaryIds: null }
;(globalThis as unknown as Record<symbol, unknown>)[guardKey] = session
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../../../../lib/authz' && context.parentURL?.includes('api/admin/navigation/route.ts')) return { shortCircuit: true, url: 'mock:navigation-boundary-guard' }
    if (context.parentURL === 'mock:navigation-boundary-guard') return next(specifier, { ...context, parentURL: import.meta.url })
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'mock:navigation-boundary-guard') return { shortCircuit: true, format: 'module', source: `
      import { NextResponse } from 'next/server';
      import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts';
      export async function guardPermission(key) {
        const authz = globalThis[Symbol.for('openbooks.navigation.boundary.guard')];
        return permissionSetCovers(authz.permissions, key) ? authz : NextResponse.json({error: 'missing permission: '+key}, {status:403});
      }` }
    return next(url, context)
  },
})
const { PUT } = await import('./route')
const dialect = new PgDialect()
const originalExecute = db.execute
const originalTransaction = db.transaction
const revision = new Date('2026-09-30T12:00:00Z')
let before: OrgNavConfig | undefined
let zeroRows = false
let zeroAuditRows = false
let queries: { sql: string; params: unknown[] }[] = []
let writes: string[] = []
let rolledBack = false

db.execute = (async (query) => {
  const compiled = dialect.sqlToQuery(query as Parameters<PgDialect['sqlToQuery']>[0]); queries.push(compiled)
  const text = compiled.sql
  assert.ok(compiled.params.includes('company-one') || text.includes('pg_advisory_xact_lock'), `organization scope: ${text}`)
  if (text.includes('from org_nav_configs')) return { rows: before ? [{ id: 'navigation-one', config: before, updated_at: revision }] : [] }
  if (text.includes('from apps a') || text.includes('from apps m')) return { rows: [] }
  if (text.includes('insert into org_nav_configs')) { writes.push('configuration'); return { rows: zeroRows ? [] : [{ id: 'navigation-one', updated_at: revision }] } }
  if (text.includes('insert into audit_log')) { writes.push('audit'); return { rows: zeroAuditRows ? [] : [{ id: 'audit-one' }] } }
  if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
  throw new Error(`Unexpected navigation write query: ${text}`)
}) as typeof db.execute

db.transaction = (async (callback: (tx: { execute: typeof db.execute }) => Promise<unknown>) => {
  try { return await callback({ execute: db.execute }) }
  catch (error) { rolledBack = true; throw error }
}) as unknown as typeof db.transaction

test.after(() => { db.execute = originalExecute; db.transaction = originalTransaction })
function draft(): OrgNavConfig { return { version: 2, architectureVersion: 1, groups: [{ id: 'work', label: 'Work', items: [{ kind: 'module', moduleKey: 'dashboard' }] }], localNavigation: { payroll: { items: [{ href: '/payroll/runs', label: 'Process wages' }, { href: '/payroll', hidden: true }] } } } }
function reset() { before = undefined; zeroRows = false; zeroAuditRows = false; queries = []; writes = []; rolledBack = false }
function request(config: unknown, expectedUpdatedAt: string | null = null) { return new Request('http://localhost/api/admin/navigation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, expectedUpdatedAt }) }) }

test('valid local preferences save and audit under the same organization fence', async () => {
  reset(); const config = draft(); const response = await PUT(request(config))
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true)
  assert.deepEqual(writes, ['configuration', 'audit'])
  const audit = queries.find((query) => query.sql.includes('insert into audit_log'))!
  const changes = JSON.parse(audit.params.find((value) => typeof value === 'string' && value.includes('"before"')) as string)
  assert.deepEqual(changes, { before: null, after: config })
  assert.ok(audit.params.includes('editor-one'))
  assert.ok(queries.find((query) => query.sql.includes('from org_nav_configs'))!.sql.includes('for update'))
})

test('unregistered and duplicate local destinations are refused before any write', async () => {
  for (const items of [[{ href: '/restricted' }], [{ href: '/payroll' }, { href: '/payroll' }]]) {
    reset(); const config = draft(); config.localNavigation!.payroll = { items }
    const response = await PUT(request(config)); assert.equal(response.status, 400); assert.deepEqual(writes, [])
  }
})

test('malformed preferences fail real request validation without touching the database', async () => {
  reset(); const config = draft(); config.localNavigation!.payroll!.items[0]!.label = ' '
  const response = await PUT(request(config)); assert.equal(response.status, 400); assert.equal(queries.length, 0)
})

test('a stale editor cannot overwrite another configuration or emit an audit', async () => {
  reset(); before = draft()
  const response = await PUT(request(draft(), '2026-09-30T11:00:00Z'))
  assert.equal(response.status, 409); assert.deepEqual(writes, [])
})

test('unchanged dormant screen preferences survive a save without accepting new dormant destinations', async () => {
  reset(); before = draft(); before.localNavigation!['app:retired-tools'] = { items: [{ href: '/apps/retired-tools?screen=overview', label: 'Prior overview' }] }
  const config = structuredClone(before)
  assert.equal((await PUT(request(config, revision.toISOString()))).status, 200)
  reset(); before = structuredClone(config); config.localNavigation!['app:retired-tools']!.items.push({ href: '/apps/retired-tools?screen=forged' })
  assert.equal((await PUT(request(config, revision.toISOString()))).status, 400); assert.deepEqual(writes, [])
})

test('a zero-row save rolls back and delivers a usable refusal instead of reporting success', async () => {
  reset(); zeroRows = true
  const response = await PUT(request(draft()))
  assert.equal(response.status, 409); assert.equal(rolledBack, true); assert.deepEqual(writes, ['configuration'])
  assert.match((await response.json()).error, /not saved; reload the editor and try again/i)
})


test('a missing audit insert refuses and rolls back the configuration save', async () => {
  reset(); zeroAuditRows = true
  const response = await PUT(request(draft()))
  assert.equal(response.status, 409); assert.equal(rolledBack, true)
  assert.deepEqual(writes, ['configuration', 'audit'])
  assert.match((await response.json()).error, /audit evidence could not be recorded/)
})
