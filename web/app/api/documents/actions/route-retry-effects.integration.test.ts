import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * /api/documents/actions retry-effects re-queues a stranded posting effect.
 * The retry reuses the document's existing posting grant (no new
 * permission), refuses anything the worker still owns, and evidences the
 * operator's reason in audit_log.
 */
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __documentRetryEffectsUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__documentRetryEffectsUser.user}')
    }
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')

const request = (body: unknown) => new Request('http://retry.local/api/documents/actions', { method: 'POST', body: JSON.stringify(body) })
const REASON = 'controller reviewed the stranded inventory issue and authorized one more attempt'

function actorFor(id: string, orgId: string): SessionUser {
  return { id, orgId, name: 'Sales rep', email: 'rep@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id }
}

async function seedPostedInvoice(org: Awaited<ReturnType<typeof createScratchOrg>>): Promise<{ docId: string; entryId: string }> {
  const entryId = randomUUID()
  const docId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`RTY-${entryId.slice(0, 8)}`},
              ${org.date}, ${org.periodId}, 'retry probe', 'draft', 'sales', '{}'::jsonb)`)
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
      values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '100.0000', 'CAD', '100.0000', 1, true, 'receivable'),
             (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', 1, false, 'revenue')`)
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, subtotal, tax_total, total,
         party_id, status, posted_entry_id, posting_period_id, open_balance)
      values (${docId}, ${org.orgId}, 'customer_invoice', ${`RTY-${docId.slice(0, 8)}`}, ${org.date}, 'CAD',
              '100.0000', '0.0000', '100.0000', ${org.customerId}, 'posted', ${entryId}, ${org.periodId}, '100.0000')`)
  })
  return { docId, entryId }
}

async function seedEffect(orgId: string, docId: string, entryId: string, date: string, status: string): Promise<string> {
  const id = randomUUID()
  const terminal = status === 'terminal_failed'
  await withBypassContext(() => db.execute(sql`
    insert into posting_effects
      (id, org_id, document_id, kind, entry_id, posting_date, status, attempt_count,
       error, terminal_failure_reason, terminal_failed_at, terminal_failed_by)
    values (${id}, ${orgId}, ${docId}, 'customer_invoice', ${entryId}, ${date}, ${status}, ${terminal ? 8 : 1},
            'probe failure', ${terminal ? 'probe failure' : null}, ${terminal ? sql`now()` : null}, ${terminal ? 'harness-probe' : null})`))
  return id
}

async function effectStatus(orgId: string, docId: string): Promise<string> {
  return withBypassContext(async () =>
    (await db.execute<{ status: string }>(sql`select status from posting_effects where document_id = ${docId} and org_id = ${orgId}`)).rows[0]!.status)
}

test('retry-effects refuses without the posting grant', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`))
    const { docId, entryId } = await seedPostedInvoice(org)
    await seedEffect(org.orgId, docId, entryId, org.date, 'terminal_failed')
    state.user = actorFor(actor, org.orgId)
    await withOrgContext(org.orgId, async () => {
      const response = await POST(request({ action: 'retry-effects', documentId: docId, reason: REASON }))
      assert.equal(response.status, 403)
      assert.match(String(JSON.stringify(await response.json())), /ar\.post/, 'refusal names the existing posting grant')
    })
    assert.equal(await effectStatus(org.orgId, docId), 'terminal_failed', 'a refused retry changes nothing')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('retry-effects refuses a missing reason and a document with no effect', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ar.read","ar.create","ar.post"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`))
    const { docId } = await seedPostedInvoice(org)
    state.user = actorFor(actor, org.orgId)
    await withOrgContext(org.orgId, async () => {
      const short = await POST(request({ action: 'retry-effects', documentId: docId, reason: 'too short' }))
      assert.equal(short.status, 400)
      assert.match(String(JSON.stringify(await short.json())), /reason/, 'the refusal names the missing reason')
      const unreasoned = await POST(request({ action: 'retry-effects', documentId: docId }))
      assert.equal(unreasoned.status, 400)
      const missing = await POST(request({ action: 'retry-effects', documentId: docId, reason: REASON }))
      assert.equal(missing.status, 404, 'a document with no effect row is a refusal, never success')
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('retry-effects refuses work the worker still owns', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ar.read","ar.create","ar.post"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`))
    const { docId, entryId } = await seedPostedInvoice(org)
    await seedEffect(org.orgId, docId, entryId, org.date, 'failed')
    state.user = actorFor(actor, org.orgId)
    await withOrgContext(org.orgId, async () => {
      const response = await POST(request({ action: 'retry-effects', documentId: docId, reason: REASON }))
      assert.equal(response.status, 422)
      assert.match(String(JSON.stringify(await response.json())), /terminal-failed/, 'the refusal names the terminal-only rule')
    })
    assert.equal(await effectStatus(org.orgId, docId), 'failed', 'a refused retry changes nothing')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('retry-effects re-queues a terminal effect with audit evidence', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ar.read","ar.create","ar.post"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`))
    const { docId, entryId } = await seedPostedInvoice(org)
    const effectId = await seedEffect(org.orgId, docId, entryId, org.date, 'terminal_failed')
    state.user = actorFor(actor, org.orgId)
    await withOrgContext(org.orgId, async () => {
      const response = await POST(request({ action: 'retry-effects', documentId: docId, reason: REASON }))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
    })
    assert.equal(await effectStatus(org.orgId, docId), 'pending', 'the stranded effect is re-queued for the worker')
    const evidence = await withBypassContext(async () =>
      (await db.execute<{ changes: unknown }>(sql`select changes from audit_log where org_id = ${org.orgId} and table_name = 'posting_effects' and row_id = ${effectId} order by at desc limit 1`)).rows[0])
    assert.match(JSON.stringify(evidence?.changes), /posting_effects_replay_authorized/, 'the replay evidences its authorization')
    assert.match(JSON.stringify(evidence?.changes), /controller reviewed/, 'the evidence carries the operator reason')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
