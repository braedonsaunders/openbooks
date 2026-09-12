import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null; afterRead: ((text: string) => Promise<void>) | null } = {
  orgId: '', actorId: '', allowed: null, afterRead: null,
}
Object.assign(globalThis, { __expenseNativeState: state, __expenseSqlText: (query: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(query).sql })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__expenseNativeState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier === '@openbooks/engine/src/db.ts' && (context.parentURL?.endsWith('/web/lib/expenses.ts') || decodeURIComponent(context.parentURL ?? '').endsWith('/web/app/api/expenses/[id]/route.ts'))) return virtual(`
      import { db as realDb } from ${JSON.stringify(root + 'engine/src/db.ts')};
      export const db = new Proxy(realDb, { get(target, key) {
        if (key !== 'execute') return Reflect.get(target, key);
        return async (query) => {
          const result = await target.execute(query);
          await globalThis.__expenseNativeState.afterRead?.(globalThis.__expenseSqlText(query));
          return result;
        };
      }});
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { documentRevisionSql } = await import('@openbooks/engine/src/document-revision.ts')
const { submitAndReleaseIfUngated } = await import('@openbooks/engine/src/flows/submit.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const { assertExpenseEmployee } = await import('@openbooks/engine/src/expense-validation.ts')
const { GET, PATCH } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture(work: (org: Awaited<ReturnType<typeof createScratchOrg>>, id: string) => Promise<void>) {
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Expense clerk', 'accountant')
    state.allowed = null
    const id = randomUUID()
    await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, memo)
      values (${id}, ${org.orgId}, 'expense_report', 'draft', ${'EXP-' + id}, ${org.date}, ${org.subsidiaryId}, 'CAD', '10', '0', '10', 'original')`)
    await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, description, tax_amount)
      values (${org.orgId}, ${id}, 1, ${org.accounts.cogs}, '1', '10', '10', 'original line', '0')`)
    await work(org, id)
  } finally {
    state.afterRead = null
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
}
const get = (id: string) => withOrgContext(state.orgId, () => GET(new Request('http://expense.test'), { params: Promise.resolve({ id }) }))
const patch = (id: string, body: unknown) => withOrgContext(state.orgId, () => PATCH(new Request('http://expense.test', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }))
async function revision(id: string) {
  return (await db.execute<{ revision: string }>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision from documents where id=${id} and org_id=${state.orgId}`)).rows[0]!.revision
}

test('expense GET keeps header, lines, exact revision and subsequent OCC save coherent across a committed writer', { skip: !DB }, async () => {
  await fixture(async (org, id) => {
    const oldRevision = await revision(id)
    state.afterRead = async (text) => {
      if (!text.includes('from documents d')) return
      state.afterRead = null
      await db.transaction(async (tx) => {
        await tx.execute(sql`update documents set memo='winner', total='20', subtotal='20', updated_at=updated_at + interval '1 microsecond' where id=${id} and org_id=${org.orgId}`)
        await tx.execute(sql`update document_lines set amount='20', description='winner line' where document_id=${id} and org_id=${org.orgId}`)
      })
    }
    const response = await get(id)
    assert.equal(response.status, 200)
    const payload = await response.json()
    const saved = await patch(id, { expectedUpdatedAt: payload.doc.updated_at, memo: payload.doc.memo, lines: [{ accountId: org.accounts.cogs, amount: '10', description: 'old drawer' }] })
    const current = (await db.execute<{ memo: string }>(sql`select memo from documents where id=${id}`)).rows[0]!
    console.log(JSON.stringify({ payloadMemo: payload.doc.memo, payloadLine: payload.lines[0].description, oldRevision, payloadRevision: payload.doc.updated_at, saveStatus: saved.status, finalMemo: current.memo }))
    assert.equal(saved.status, 409, 'a stale drawer must not receive the winner revision and overwrite it')
    assert.equal(current.memo, 'winner')
    assert.equal(payload.lines[0].description, 'original line')
    assert.equal(payload.lines[0].amount, '10.0000')
    assert.equal(payload.doc.updated_at, oldRevision)
  })
})

test('expense draft with omitted employee cannot submit or post without reimbursable open-item evidence', { skip: !DB }, async () => {
  await fixture(async (org, id) => {
    const saved = await patch(id, { expectedUpdatedAt: await revision(id), lines: [{ accountId: org.accounts.cogs, amount: '123.45' }] })
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()))
    const before = await revision(id)
    let rejection: unknown
    try {
      await withOrgContext(org.orgId, () => submitAndReleaseIfUngated('expense_report', id, state.actorId))
    } catch (error) { rejection = error }
    if (!rejection) {
      const entry = await withOrgContext(org.orgId, () => postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank, employeePayable: org.accounts.ap } }))
      console.log('BEFORE missing employee posted', (await db.execute(sql`select party_id, is_open_item, amount::text from journal_lines where entry_id=${entry} and account_id=${org.accounts.ap}`)).rows)
    }
    assert.match(String(rejection), /employee/i, 'submission must fail at the domain boundary')
    const header = (await db.execute<{ status: string; submitted_at: unknown; posted_entry_id: unknown }>(sql`select status, submitted_at, posted_entry_id from documents where id=${id}`)).rows[0]!
    assert.equal(header.status, 'draft')
    assert.equal(header.submitted_at, null)
    assert.equal(header.posted_entry_id, null)
    assert.equal(await revision(id), before, 'rejected submission rolls back revision and evidence')
    await db.execute(sql`update documents set status='approved' where id=${id}`)
    await assert.rejects(withOrgContext(org.orgId, () => postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })), /employee/i)
    assert.equal((await db.execute(sql`select id from journal_entries where source_document_id=${id}`)).rows.length, 0)
  })
})

test('expense GET and PATCH scope checks cannot authorize a different subsidiary snapshot', { skip: !DB }, async () => {
  await fixture(async (org, id) => {
    const otherSub = randomUUID()
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country) values (${otherSub}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA')`)
    state.allowed = new Set([org.subsidiaryId])
    state.afterRead = async (text) => {
      if (!text.includes('from documents')) return
      state.afterRead = null
      await db.execute(sql`update documents set subsidiary_id=${otherSub}, memo='restricted entity' where id=${id} and org_id=${org.orgId}`)
    }
    const response = await get(id)
    if (response.status === 200) {
      const payload = await response.json()
      assert.equal(payload.doc.subsidiary_id, org.subsidiaryId, 'only the authorized snapshot can be disclosed')
      assert.equal(payload.doc.memo, 'original')
    } else assert.equal(response.status, 404)
    assert.equal((await get(id)).status, 404)
    await db.execute(sql`update documents set subsidiary_id=${org.subsidiaryId}, memo='original' where id=${id}`)
    const before = await revision(id)
    let rehomedRevision = ''
    state.afterRead = async (text) => {
      if (!text.includes('from documents')) return
      state.afterRead = null
      await db.execute(sql`update documents set subsidiary_id=${otherSub} where id=${id} and org_id=${org.orgId}`)
      rehomedRevision = await revision(id)
    }
    const denied = await patch(id, { expectedUpdatedAt: before, memo: 'unauthorized overwrite' })
    assert.equal(denied.status, 404)
    assert.equal((await db.execute<{ memo: string }>(sql`select memo from documents where id=${id}`)).rows[0]!.memo, 'original')
    assert.equal(await revision(id), rehomedRevision, 'denied save leaves the winning rehome revision unchanged')
  })
})

test('expense payload preserves every financial decimal as an exact string', { skip: !DB }, async () => {
  await fixture(async (_org, id) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`update documents set subtotal='999999999999999.9998', tax_total='0.0001', total='999999999999999.9999', fx_rate='1.1234567890' where id=${id}`)
      await tx.execute(sql`update document_lines set amount='999999999999999.9998', tax_input_amount='999999999999999.9997', tax_amount='0.0001' where document_id=${id}`)
    })
    const payload = await (await get(id)).json()
    assert.equal(payload.doc.subtotal, '999999999999999.9998')
    assert.equal(payload.doc.total, '999999999999999.9999')
    assert.equal(payload.doc.fx_rate, '1.1234567890')
    assert.equal(payload.lines[0].amount, '999999999999999.9998')
    assert.equal(payload.lines[0].tax_input_amount, '999999999999999.9997')
    assert.equal(payload.lines[0].tax_amount, '0.0001')
  })
})

test('expense PATCH response cannot bless stale content with a later writer revision', { skip: !DB }, async () => {
  await fixture(async (org, id) => {
    const before = await revision(id)
    state.afterRead = async (text) => {
      if (!text.includes('from documents d')) return
      state.afterRead = null
      await db.transaction(async (tx) => {
        await tx.execute(sql`update documents set memo='later winner', updated_at=updated_at + interval '1 microsecond' where id=${id} and org_id=${org.orgId}`)
        await tx.execute(sql`update document_lines set description='later winner line' where document_id=${id}`)
      })
    }
    const saved = await patch(id, { expectedUpdatedAt: before, memo: 'first save' })
    assert.equal(saved.status, 200)
    const payload = await saved.json()
    assert.equal(payload.doc.memo, 'first save')
    assert.equal(payload.lines[0].description, 'original line')
    assert.equal((await patch(id, { expectedUpdatedAt: payload.doc.updated_at, memo: payload.doc.memo })).status, 409)
    assert.equal((await db.execute<{ memo: string }>(sql`select memo from documents where id=${id}`)).rows[0]!.memo, 'later winner')
  })
})

test('expense employee identity rejects vendor-only parties but preserves former dual-role employee reimbursements', { skip: !DB }, async () => {
  await fixture(async (org, id) => {
    await db.execute(sql`update documents set party_id=${org.vendorId} where id=${id}`)
    const before = await revision(id)
    await assert.rejects(withOrgContext(org.orgId, () => submitAndReleaseIfUngated('expense_report', id, state.actorId)), /employee in this organization/)
    assert.equal(await revision(id), before)
    await db.execute(sql`update documents set status='approved' where id=${id}`)
    await assert.rejects(withOrgContext(org.orgId, () => postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })), /employee in this organization/)
    assert.equal((await db.execute(sql`select id from journal_entries where source_document_id=${id}`)).rows.length, 0)
    await db.execute(sql`update documents set status='draft' where id=${id}`)
    await db.execute(sql`insert into employee_roles (org_id, party_id, is_active) values (${org.orgId}, ${org.vendorId}, false)`)
    await db.execute(sql`update parties set is_active=false where id=${org.vendorId}`)
    await assert.rejects(assertExpenseEmployee(db, { kind: 'expense_report', orgId: randomUUID(), partyId: org.vendorId }), /employee in this organization/)
    assert.equal((await withOrgContext(org.orgId, () => submitAndReleaseIfUngated('expense_report', id, state.actorId))).autoApproved, true)
    const entry = await withOrgContext(org.orgId, () => postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }))
    const control = (await db.execute<{ party_id: string; is_open_item: boolean; amount: string }>(sql`select party_id, is_open_item, amount::text from journal_lines where entry_id=${entry} and account_id=${org.accounts.ap}`)).rows[0]!
    assert.deepEqual(control, { party_id: org.vendorId, is_open_item: true, amount: '-10.0000' })
  })
})

test.after(async () => { await pool.end() })
