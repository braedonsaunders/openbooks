import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// OM-09b: expenses PATCH must refuse a contentful line without an account
// with a 422 naming the line — and write nothing. prepareExpenseEdit runs
// every submitted line through validateEditableDocumentLines, which names
// the line; the drawer used to drop the row before it ever arrived. Only
// the feature gate is stubbed; handler, service, and storage are real.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __expenseAccountlessState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__expenseAccountlessState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { documentRevisionCounterSql } = await import('@openbooks/engine/src/records/revision.ts')
const { PATCH } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

const patch = (id: string, body: unknown) => withOrgContext(state.orgId, () => PATCH(new Request('http://expense.test', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }))
async function revision(id: string) {
  return (await withOrgContext(state.orgId, () => db.execute<{ revision: string }>(sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${state.orgId}`))).rows[0]!.revision
}
async function storedState(orgId: string, id: string): Promise<{ total: string; n: number; amounts: string[] }> {
  const doc = (await withOrgContext(orgId, () => db.execute<{ total: string }>(sql`select total::text as total from documents where id=${id} and org_id=${orgId}`))).rows[0]!
  const lines = (await withOrgContext(orgId, () => db.execute<{ amount: string }>(sql`select amount::text as amount from document_lines where document_id=${id} and org_id=${orgId} order by line_number`))).rows
  return { total: doc.total, n: lines.length, amounts: lines.map((l) => l.amount) }
}

test('expenses PATCH refuses an account-less contentful line with its line number and writes nothing', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Expense clerk', 'accountant'))
    state.allowed = null
    const id = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, memo)
        values (${id}, ${org.orgId}, 'expense_report', 'draft', ${'EXP-' + id}, ${org.date}, ${org.subsidiaryId}, 'CAD', '500', '0', '500', 'original')`)
      await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, description, tax_amount)
        values (${org.orgId}, ${id}, 1, ${org.accounts.cogs}, '1', '500', '500', 'hotel', '0')`)
    })
    const refused = await patch(id, {
      expectedUpdatedAt: await revision(id),
      lines: [
        { accountId: org.accounts.cogs, amount: '500', description: 'hotel', settlementType: 'out_of_pocket' },
        { accountId: '', amount: '225', description: 'taxi', settlementType: 'company_paid' },
      ],
    })
    assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(await refused.clone().json())}`)
    const body = (await refused.json()) as { error?: unknown }
    assert.match(
      String(body.error ?? ''),
      /Line 2: an account is required/,
      'the refusal must name the offending line and the remedy',
    )
    assert.deepEqual(await storedState(org.orgId, id), {
      total: '500.0000',
      n: 1,
      amounts: ['500.0000'],
    })
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})
