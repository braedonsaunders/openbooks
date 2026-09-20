import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __payappRetainageSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__payappRetainageSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const { updateCompanySettings } = await import('../../../lib/company-settings')
const construction = await import('./route')

const asUser = (orgId: string, actor: string) => {
  session.user = { id: actor, orgId, name: 'Payapp controller', email: 'payapp@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor }
}
const post = (handler: (req: Request) => Promise<Response>, orgId: string, body: Record<string, unknown>) =>
  withOrgContext(orgId, () => handler(new Request('http://audit.local/api', { method: 'POST', body: JSON.stringify(body) })))
async function okJson(res: Response, action: string): Promise<Record<string, string>> {
  assert.equal(res.status >= 200 && res.status < 300, true, `${action} -> ${res.status} ${JSON.stringify(await res.clone().json().catch(() => null))}`)
  return res.json() as Promise<Record<string, string>>
}

/**
 * F-t04-002: a change-order-created SOV line carries retainage_percent NULL
 * ("default"), so it bills at the application default (10%) and demands a
 * Retainage Receivable control account — which has no slot in Company control
 * accounts and is silently dropped by the settings writer. Billing the draw
 * must refuse with a visible reason until the account exists, then complete.
 */
test('a retainage-bearing pay application is billable once the receivable control exists', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const preparer = await createScratchUser(org.orgId, 'Preparer', 'reviewer')
    const approver = await createScratchUser(org.orgId, 'Approver', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)

    const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
    const typeId = randomUUID(), project = randomUUID()
    const lineA = randomUUID(), lineB = randomUUID()
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'retainage fixture')`)
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
      values (${project},${org.orgId},${org.subsidiaryId},'RET','Retainage control job',${org.customerId},${typeId},'active',true)`)
    // Manual lines carry an explicit 0% — the finding's $100k/$80k lines.
    for (const [id, description, value] of [[lineA, 'Structure', '100000'], [lineB, 'Envelope', '80000']] as const) {
      await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,retainage_percent,income_account_id,sort_order)
        values (${id},${org.orgId},${project},${description},${value},'0',${org.accounts.revenue},1)`)
    }
    // The change order lands a new schedule line exactly like the product
    // path: no retainage_percent, so the row reads NULL ("default").
    asUser(org.orgId, preparer)
    const added = await post(construction.POST, org.orgId, { action: 'addChangeOrder', projectId: project, number: 'CO-001', description: 'Extra scope', amount: '12000', incomeAccountId: org.accounts.revenue })
    const coId = (await okJson(added, 'addChangeOrder') as { id: string }).id
    asUser(org.orgId, approver)
    await okJson(await post(construction.POST, org.orgId, { action: 'approveChangeOrder', id: coId }), 'approveChangeOrder')
    const coLine = (await db.execute<{ id: string; retainage_percent: string | null }>(sql`select id, retainage_percent from sov_lines where org_id=${org.orgId} and project_id=${project} and change_order_id=${coId}`)).rows[0]!
    assert.equal(coLine.retainage_percent, null, 'the CO-created line must carry NULL retainage (the reported trigger)')

    // Draw on all three lines; the NULL line bills at the 10% app default.
    asUser(org.orgId, preparer)
    const appId = (await okJson(await post(construction.POST, org.orgId, { action: 'createPayApp', projectId: project, periodEnd: org.date }), 'createPayApp') as { id: string }).id
    await okJson(await post(construction.POST, org.orgId, {
      action: 'submitPayApp', payApplicationId: appId,
      lines: [
        { sovLineId: lineA, thisPeriodCompleted: '50000' },
        { sovLineId: lineB, thisPeriodCompleted: '20000' },
        { sovLineId: coLine.id, thisPeriodCompleted: '12000' },
      ],
    }), 'submitPayApp')
    asUser(org.orgId, approver)
    await okJson(await post(construction.POST, org.orgId, { action: 'approvePayApp', payApplicationId: appId }), 'approvePayApp')

    // 1. Without the control account the refusal names the missing setup.
    asUser(org.orgId, preparer)
    const blocked = await post(construction.POST, org.orgId, { action: 'billPayApp', payApplicationId: appId })
    assert.equal(blocked.status, 422)
    assert.match(String((await blocked.json() as { error: string }).error), /Retainage Receivable control account/i)

    // 2. The sanctioned setup path persists the account (today it is dropped).
    const retAcct = randomUUID()
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${retAcct}, ${org.orgId}, '1210', 'Retainage Receivable', 'asset_receivable', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    const saved = await withOrgContext(org.orgId, () => updateCompanySettings(
      { orgId: org.orgId, id: preparer },
      { controlAccounts: { retainageReceivable: retAcct } },
    ))
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const stored = (await db.execute<{ control: Record<string, string> }>(sql`select settings->'controlAccounts' as control from orgs where id=${org.orgId}`)).rows[0]!.control
    assert.equal(stored.retainageReceivable, retAcct, 'Company control accounts must keep the retainage receivable mapping')

    // 3. The same draw now invoices: $82,000 gross, $1,200 held, $80,800 due.
    const billed = await post(construction.POST, org.orgId, { action: 'billPayApp', payApplicationId: appId })
    const invoice = await okJson(billed, 'billPayApp') as { invoiceId: string; currentDue: string; retainage: string }
    assert.equal(invoice.currentDue, '80800.0000')
    assert.equal(invoice.retainage, '1200.0000')
    const lines = (await db.execute<{ account_id: string; amount: string }>(sql`select account_id, amount::text from document_lines where org_id=${org.orgId} and document_id=${invoice.invoiceId} order by line_number`)).rows
    assert.deepEqual(lines.map((l) => l.amount), ['50000.0000', '20000.0000', '12000.0000', '-1200.0000'])
    assert.equal(lines[3]!.account_id, retAcct)
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
