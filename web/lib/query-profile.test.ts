import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQueryProfile, normalizeStatement, startQueryProfile } from './query-profile'

/**
 * The per-route profile attributes round trips to the request that issued
 * them, closes a request only once it is idle, reports distributions and
 * within-request repetition per route, and never records a literal value.
 */

function harness() {
  let clock = 0
  let current: { key: object; route: string } | undefined
  const profile = createQueryProfile({
    currentRequest: () => current,
    now: () => clock,
    requestIdleMs: 1_000,
  })
  return {
    profile,
    advance: (ms: number) => { clock += ms },
    within: (request: { key: object; route: string } | undefined, statements: Array<[string, number]>) => {
      current = request
      for (const [statement, ms] of statements) profile.observe(statement, ms)
      current = undefined
    },
  }
}

test('normalization removes every literal and placeholder so no value reaches the profile', () => {
  const shape = normalizeStatement(`
    select "t1"."id", t2.amount -- tenant 'Acme Ltd'
    from invoices t1 /* org 7f3c */ join lines t2 on t2.invoice_id = t1.id
    where t1.org_id = $1 and t1.memo = 'O''Brien -- not a comment' and t1.note = E'it\\'s'
      and t1.total > 1250.75 and t1.body = $tag$secret$tag$ and t1.id in ($2, $3, $4)
    limit 50
  `)
  assert.equal(
    shape,
    'select "t1"."id", t2.amount from invoices t1 join lines t2 on t2.invoice_id = t1.id where t1.org_id = ? and t1.memo = ? and t1.note = ? and t1.total > ? and t1.body = ? and t1.id in (?, ...) limit ?',
  )
  for (const value of ['Acme', '7f3c', "O''Brien", "it\\'s", '1250', 'secret', '50']) {
    assert.ok(!shape.includes(value), `normalized statement retains ${value}`)
  }
})

test('statements that differ only in values share one shape, including multi-row inserts', () => {
  assert.equal(
    normalizeStatement("select * from parties where id = 'a1'"),
    normalizeStatement('select * from parties where id = $1'),
  )
  assert.equal(
    normalizeStatement('insert into tags (a, b) values ($1, $2), ($3, $4), ($5, $6)'),
    normalizeStatement('insert into tags (a, b) values (1, 2), (3, 4)'),
  )
  assert.ok(normalizeStatement(`select '${'x'.repeat(50)}', ${'col, '.repeat(400)}1`).length <= 601)
})

test('round trips are attributed per request and summarized per route with mean and p95', () => {
  const { profile, advance, within } = harness()
  const route = '/(app)/reports/pnl'
  // Twenty requests: nineteen with two round trips, one with twenty.
  for (let i = 0; i < 20; i += 1) {
    const trips = i === 19 ? 20 : 2
    within({ key: {}, route }, Array.from({ length: trips }, (_, n): [string, number] => [`select ${n}`, 1.5]))
  }
  within({ key: {}, route: '/api/health' }, [['select 1', 0.25]])
  within(undefined, [['select now()', 4]])
  advance(1_000)

  const summary = profile.summarize()
  assert.ok(summary)
  assert.deepEqual(summary.unattributed, { roundTrips: 1, dbMs: 4 })
  assert.equal(summary.openRequests, 0)
  const pnl = summary.routes.find((r) => r.route === route)
  assert.ok(pnl)
  assert.equal(pnl.requests, 20)
  assert.deepEqual(pnl.roundTrips, { mean: 2.9, p95: 2, max: 20 })
  assert.deepEqual(pnl.dbMs, { mean: 4.35, p95: 3, max: 30, total: 87 })
  assert.equal(summary.routes[0]?.route, route, 'routes are ordered by total database time')
  assert.equal(profile.summarize(), null, 'a window with no activity writes nothing')
})

test('a request still issuing statements is reported only once it has been idle', () => {
  const { profile, advance, within } = harness()
  const request = { key: {}, route: '/(app)/projects' }
  within(request, [['select 1', 1]])
  advance(500)
  within(request, [['select 2', 1]])
  advance(600)

  const early = profile.summarize()
  assert.ok(early === null || early.routes.length === 0)

  within(request, [['select 3', 1]])
  advance(1_000)
  const later = profile.summarize()
  assert.ok(later)
  assert.equal(later.openRequests, 0)
  assert.deepEqual(later.routes.map((r) => [r.route, r.requests, r.roundTrips.max]), [['/(app)/projects', 1, 3]])
})

test('statements repeated within one request rank by repetition; once-per-request statements are not reported', () => {
  const { profile, advance, within } = harness()
  const route = '/(app)/sales/invoices'
  const lookup = (id: number): [string, number] => [`select name from parties where id = ${id}`, 2]
  within({ key: {}, route }, [['select count(*) from invoices', 3], lookup(1), lookup(2), lookup(3), ['select 1 from settings', 1], ['select 1 from settings', 1]])
  within({ key: {}, route }, [['select count(*) from invoices', 3], lookup(4), lookup(5)])
  advance(1_000)

  const [routeProfile] = profile.summarize()!.routes
  assert.deepEqual(routeProfile?.repeatedStatements, [
    { statement: 'select name from parties where id = ?', repeats: 3, executions: 5, requestsRepeating: 2, maxPerRequest: 3, totalDbMs: 10 },
    { statement: 'select ? from settings', repeats: 1, executions: 2, requestsRepeating: 1, maxPerRequest: 2, totalDbMs: 2 },
  ])
})

test('the top repeated statements are capped at ten', () => {
  const { profile, advance, within } = harness()
  const statements: Array<[string, number]> = []
  for (let table = 0; table < 15; table += 1) {
    for (let n = 0; n <= table; n += 1) statements.push([`select * from table_${String.fromCharCode(97 + table)}`, 1])
  }
  within({ key: {}, route: '/(app)/dashboard' }, statements)
  advance(1_000)
  const repeated = profile.summarize()!.routes[0]?.repeatedStatements ?? []
  assert.equal(repeated.length, 10)
  assert.equal(repeated[0]?.statement, 'select * from table_o')
  assert.equal(repeated[0]?.repeats, 14)
})

test('an enabled profiler refuses to start without an output file', () => {
  assert.throws(
    () => startQueryProfile({ OPENBOOKS_QUERY_PROFILE: '1', OPENBOOKS_QUERY_PROFILE_FILE: '  ' }),
    /requires OPENBOOKS_QUERY_PROFILE_FILE/,
  )
})

test('slow statements include costly single executions with normalized values', () => {
  const { profile, within, advance } = harness()
  within({ key: {}, route: '/projects/pre-billing' }, [
    ["select payload from requests where org_id = 'tenant-secret'", 8_000],
    ['select 1', 2], ['select 2', 3],
  ])
  advance(1_000)
  const route = profile.summarize()!.routes[0]!
  assert.equal(route.repeatedStatements.some((row) => row.statement.includes('payload')), false)
  assert.deepEqual(route.slowStatements[0], {
    statement: 'select payload from requests where org_id = ?', executions: 1, totalDbMs: 8_000, meanDbMs: 8_000,
  })
  assert.equal(JSON.stringify(route).includes('tenant-secret'), false)
})
