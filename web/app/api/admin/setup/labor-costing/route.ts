import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'
const POLICIES = ['work_date', 'locked', 'scheduled_escalation', 'manual_reprice'] as const
const MODES = ['costing_only', 'variance_to_clearing'] as const

export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const rateBookId = String(body.rateBookId ?? '')
  const policy = String(body.policy ?? '')
  const laborWip = String(body.laborWip ?? '') || null
  const laborClearing = String(body.laborClearing ?? '') || null
  const mode = String(body.accountingMode ?? 'costing_only')
  const projectTypeIds = Array.isArray(body.projectTypeIds) ? body.projectTypeIds.map(String) : []
  if (!isUuid(rateBookId) || !POLICIES.includes(policy as typeof POLICIES[number])) return NextResponse.json({ error: 'Choose a rate book and policy' }, { status: 422 })
  if (!MODES.includes(mode as typeof MODES[number])) return NextResponse.json({ error: 'Invalid external-payroll mode' }, { status: 422 })
  if ((laborWip && !isUuid(laborWip)) || (laborClearing && !isUuid(laborClearing)) || projectTypeIds.some((id) => !isUuid(id))) return NextResponse.json({ error: 'Invalid account or project type' }, { status: 422 })
  if (mode === 'variance_to_clearing' && (!laborWip || !laborClearing)) return NextResponse.json({ error: 'Variance accounting requires labor WIP and clearing accounts' }, { status: 422 })
  try {
    await db.transaction(async (tx) => {
      const book = (await tx.execute(sql`select 1 from item_rate_books where id = ${rateBookId} and org_id = ${gate.user.orgId} and is_active`)) as any
      if (!book.rows[0]) throw new Error('Rate book not found')
      const accountIds = [laborWip, laborClearing].filter((id): id is string => !!id)
      if (accountIds.length) {
        const accounts = (await tx.execute(sql`select id from accounts where org_id = ${gate.user.orgId} and not is_summary and is_active and id in ${sql.join(accountIds.map((id) => sql`${id}`), sql`,`)}`)) as any
        if (accounts.rows.length !== new Set(accountIds).size) throw new Error('A control account is unavailable')
      }
      if (projectTypeIds.length) {
        const types = (await tx.execute(sql`select id from project_types where org_id = ${gate.user.orgId} and id in ${sql.join(projectTypeIds.map((id) => sql`${id}`), sql`,`)}`)) as any
        if (types.rows.length !== new Set(projectTypeIds).size) throw new Error('A project type is unavailable')
      }
      const org = (await tx.execute(sql`select settings from orgs where id = ${gate.user.orgId} for update`)) as any
      const settings = (org.rows[0]?.settings ?? {}) as Record<string, unknown>
      const control = (settings.controlAccounts ?? {}) as Record<string, unknown>
      const laborCosting = (settings.laborCosting ?? {}) as Record<string, unknown>
      const nextSettings = {
        ...settings,
        controlAccounts: { ...control, laborWip, laborClearing },
        laborCosting: { ...laborCosting, defaultRatePolicy: policy, externalPayrollMode: mode },
      }
      await tx.execute(sql`update orgs set settings = ${JSON.stringify(nextSettings)}::jsonb, updated_at = now(), updated_by = ${gate.user.id} where id = ${gate.user.orgId}`)
      await tx.execute(sql`update item_rate_books set is_default = (id = ${rateBookId}), updated_at = now(), updated_by = ${gate.user.id} where org_id = ${gate.user.orgId}`)
      if (projectTypeIds.length) await tx.execute(sql`
        update project_types set labor_rate_book_id = ${rateBookId}, labor_rate_policy = ${policy}, updated_at = now(), updated_by = ${gate.user.id}
         where org_id = ${gate.user.orgId} and id in ${sql.join(projectTypeIds.map((id) => sql`${id}`), sql`,`)}`)
      if (body.createExternalSource === true) {
        await tx.execute(sql`
          insert into external_payroll_sources
            (org_id, code, name, accounting_mode, payroll_clearing_account_id, require_posted_journal, is_active, created_by, updated_by)
          values (${gate.user.orgId}, 'EXTERNAL_PAYROLL', ${String(body.sourceName ?? 'External Payroll').trim() || 'External Payroll'},
                  ${mode}, ${mode === 'variance_to_clearing' ? laborClearing : null}, ${mode === 'variance_to_clearing'}, true, ${gate.user.id}, ${gate.user.id})
          on conflict (org_id, code) do update set accounting_mode = excluded.accounting_mode,
            payroll_clearing_account_id = excluded.payroll_clearing_account_id,
            require_posted_journal = excluded.require_posted_journal, updated_at = now(), updated_by = excluded.updated_by`)
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'orgs', ${gate.user.orgId}, 'update',
                ${JSON.stringify({ action: 'labor-costing-wizard', rateBookId, policy, mode, projectTypeIds })}::jsonb, ${gate.user.id})`)
    })
    return NextResponse.json({ ok: true })
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 422 }) }
}
