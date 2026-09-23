import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __timesheetSaveControls: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__timesheetSaveControls.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PUT } = await import('./route')

async function fixture(requireApproval: boolean) {
  const org = await createScratchOrg()
  const actor = await createScratchUser(org.orgId, 'Timesheet auditor', 'reviewer')
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
  session.user = { id: actor, orgId: org.orgId, name: 'Auditor', email: 'auditor@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  const employee = randomUUID(), project = randomUUID()
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: true, timeTracking: true }, timesheets: { requireApproval },
    laborCosting: { mode: 'post', hoursPerDay: 8, annualHours: 2080, components: [] },
    controlAccounts: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank, laborWip: org.accounts.cogs, laborClearing: org.accounts.clearing },
  })}::jsonb where id=${org.orgId}`)
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${employee},${org.orgId},'employee','Time worker',${org.subsidiaryId},true,'{}'::jsonb)`)
  await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${employee},true)`)
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${project},${org.orgId},${org.subsidiaryId},'SAVE','Time save',${org.customerId},'active',true,'{}'::jsonb)`)
  await db.execute(sql`insert into labor_cost_rates(org_id,employee_party_id,currency,rate,basis,effective_from,is_active)
    values (${org.orgId},${employee},'CAD','30','hour','2026-01-01',true)`)
  await db.execute(sql`update items set default_rate='100' where org_id=${org.orgId} and id=${org.items.service}`)
  const row = { projectId: project, itemId: org.items.service, isBillable: true, hours: ['', '', '', '4', '', '', ''] }
  const save = (body: object) => withOrgContext(org.orgId, () => PUT(new Request('http://audit.local/api/timesheets', {
    method: 'PUT', body: JSON.stringify({ employee, week: '2026-07-12', rows: [row], ...body }),
  })))
  const snapshot = () => db.execute(sql`select * from time_entries where org_id=${org.orgId} order by id`)
  const close = async () => { session.user = null; await dropScratchOrgReporting(org.orgId) }
  return { org, actor, employee, project, row, save, snapshot, close }
}

test('malformed weekly grids cannot erase existing hours', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture(true)
  try {
    assert.equal((await f.save({})).status, 200)
    const before = (await f.snapshot()).rows
    assert.equal(before.length, 1)
    for (const body of [
      { rows: [{ ...f.row, hours: {} }] },
      { rows: [{ ...f.row, hours: null }] },
      { rows: [{ projectId: f.project }] },
      { rows: [null] },
      { rows: [{ ...f.row, isBillable: 'true' }] },
      { rows: [{ ...f.row, hours: ['', '', '', '4', '', '', '', '8'] }] },
      { week: '2026-02-30', rows: [] },
    ]) {
      const response = await f.save(body)
      assert.equal(response.status, 422, JSON.stringify(body))
      assert.deepEqual((await f.snapshot()).rows, before)
    }
    // An intentional empty grid still clears editable time.
    assert.equal((await f.save({ rows: [] })).status, 200)
    assert.equal((await f.snapshot()).rows.length, 0)
  } finally { await f.close() }
})

test('saving immediately approved hours captures rates and posts configured labor atomically', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture(false)
  try {
    const response = await f.save({})
    assert.equal(response.status, 200, await response.clone().text())
    const entry = (await f.snapshot()).rows[0]!
    assert.equal(entry.status, 'approved')
    assert.equal(entry.cost_rate, '30.0000')
    assert.equal(entry.bill_rate, '100.0000')
    assert.ok(entry.cost_journal_entry_id)
    assert.equal(entry.approved_by, null, 'automatic availability must not invent an approver')
    const journal = (await db.execute(sql`select count(*)::int as lines, sum(amount)::text as balance from journal_lines where org_id=${f.org.orgId} and entry_id=${entry.cost_journal_entry_id}`)).rows[0]!
    assert.equal(journal.lines, 2)
    assert.equal(journal.balance, '0.0000')
    // The next day's automatic approval preserves the first day's posted
    // evidence and applies effects only to the newly captured hours.
    assert.equal((await f.save({ rows: [{ ...f.row, hours: ['', '', '', '', '2', '', ''] }] })).status, 200)
    const before = (await f.snapshot()).rows
    assert.equal(before.length, 2)
    assert.deepEqual(before.find(row => row.id === entry.id), entry)
    const posted = (await db.execute(sql`select sum(l.amount)::text as cost from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
      where l.org_id=${f.org.orgId} and l.account_id=${f.org.accounts.cogs} and e.status='posted'`)).rows[0]!
    assert.equal(posted.cost, '180.0000')
    // No accounting period exists for this second date. Failed effects must
    // roll back the time insert as well as the journal work.
    await assert.rejects(f.save({ week: '2026-08-02' }), /no accounting period covers/)
    assert.deepEqual((await f.snapshot()).rows, before)
  } finally { await f.close() }
})

test('replaying an identical save returns the stored week without duplicating hours or effects', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // With automatic approval the first save leaves approved entries behind.
  // A replayed grid must resolve to those rows — not insert a second copy of
  // the week's hours alongside fresh financial effects.
  const f = await fixture(false)
  try {
    assert.equal((await f.save({})).status, 200)
    const first = (await f.snapshot()).rows
    assert.equal(first.length, 1)
    const journalsBefore = (await db.execute(sql`select count(*)::int as n from journal_entries where org_id=${f.org.orgId}`)).rows[0]!.n
    const replay = await f.save({})
    assert.equal(replay.status, 200, await replay.clone().text())
    const second = (await f.snapshot()).rows
    assert.deepEqual(second.map((row) => row.id), first.map((row) => row.id), 'replay must reuse the stored rows')
    assert.deepEqual(second, first)
    const journalsAfter = (await db.execute(sql`select count(*)::int as n from journal_entries where org_id=${f.org.orgId}`)).rows[0]!.n
    assert.equal(journalsAfter, journalsBefore, 'replay must not post fresh financial effects')
  } finally { await f.close() }
})

test('replaying a draft grid reuses the stored rows instead of churning them', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture(true)
  try {
    assert.equal((await f.save({})).status, 200)
    const first = (await f.snapshot()).rows
    assert.equal(first.length, 1)
    assert.equal((await f.save({})).status, 200)
    assert.deepEqual((await f.snapshot()).rows, first)
  } finally { await f.close() }
})

test('time cannot be pinned to a party without an active employment', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture(true)
  try {
    assert.equal((await f.save({})).status, 200)
    // A vendor party (no employee role at all) is not an employee.
    const vendor = randomUUID()
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values (${vendor},${f.org.orgId},'vendor','No Employment',${f.org.subsidiaryId},true,'{}'::jsonb)`)
    const refused = await f.save({ employee: vendor })
    assert.equal(refused.status, 422, await refused.clone().text())
    assert.match(((await refused.json()) as { error: string }).error, /Employee not found/)
    // Deactivating the employment closes the pin even though the party stays.
    await db.execute(sql`update employee_roles set is_active = false where org_id=${f.org.orgId} and party_id=${f.employee}`)
    const closed = await f.save({})
    assert.equal(closed.status, 422, await closed.clone().text())
    assert.match(((await closed.json()) as { error: string }).error, /Employee not found/)
    assert.equal((await f.snapshot()).rows.length, 1, 'refused pins store nothing new')
  } finally { await f.close() }
})

test('an hours cell wider than the ledger column fails closed without writing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // time_entries.hours is numeric(19,4): a pasted 20-digit cell cleared the
  // exact-decimal check and died in Postgres with a storage error. Fail
  // closed with the named 422 and write nothing.
  const f = await fixture(true)
  try {
    const response = await f.save({ rows: [{ ...f.row, hours: ['99999999999999999999', '', '', '', '', '', ''] }] })
    assert.equal(response.status, 422, await response.clone().text())
    assert.match(((await response.json()) as { error: string }).error, /Hours/)
    assert.equal((await f.snapshot()).rows.length, 0)
    // The column maximum itself still saves.
    const ok = await f.save({ rows: [{ ...f.row, hours: ['999999999999999.9999', '', '', '', '', '', ''] }] })
    assert.equal(ok.status, 200, await ok.clone().text())
    assert.equal((await f.snapshot()).rows.length, 1)
  } finally { await f.close() }
})

test('a foreign reference custom value cannot be saved on a time row', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture(false)
  const foreign = await createScratchOrg()
  try {
    await db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${f.org.orgId}, 'time_entries', null, 'line_ref', 'Line reference', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${f.actor}, ${f.actor})
    `)
    const refused = await f.save({ rows: [{ ...f.row, custom: { line_ref: foreign.vendorId } }] })
    assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${await refused.clone().text()}`)
    assert.equal((await f.snapshot()).rows.length, 0, 'refused references store nothing')
    const saved = await f.save({ rows: [{ ...f.row, custom: { line_ref: f.org.vendorId } }] })
    assert.equal(saved.status, 200, `own-org reference must stay green: ${await saved.clone().text()}`)
    assert.equal((await f.snapshot()).rows.length, 1)
  } finally {
    await dropScratchOrgReporting(foreign.orgId)
    await f.close()
  }
})
