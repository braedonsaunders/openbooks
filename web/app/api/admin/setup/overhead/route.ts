import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FinancialProfile } from '@openbooks/schema'
import { applyOverheadPairs } from '@openbooks/engine/src/overhead-apply.ts'
import { isUuid } from '../../../../../lib/list-params'
import { guardPermission } from '../../../../../lib/authz'
import { trueCostData } from '../../../../../lib/analytics/true-cost-data'

export const dynamic = 'force-dynamic'

/**
 * Overhead connective tissue — the loop between the rate ENGINE (Overhead
 * Model), the rate CARD (overhead_rates), and the POLICY (project types).
 *
 *  action=publish  Snapshot per-department $/hr rates into overhead_rates as
 *                  effective-dated rows (closing open ones). Rates come from
 *                  the live engine unless explicit rates are provided (wizard
 *                  manual entry).
 *  action=apply    Write an OverheadSource onto the chosen project types, and
 *                  make the P&L actually carry it (totalCost component +
 *                  layout line) — one pass, nothing left half-configured.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const body = await req.json().catch(() => ({}))

  if (body.action === 'publish') {
    const effectiveFrom: string = body.effectiveFrom
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom ?? '')) {
      return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) required' }, { status: 400 })
    }
    let rates: { departmentId: string; ratePerHour: number }[] = Array.isArray(body.rates) ? body.rates : []
    if (rates.length === 0) {
      // No explicit rates → snapshot the live engine (trailing 12 months).
      const to = new Date()
      const from = new Date(to)
      from.setFullYear(from.getFullYear() - 1)
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      const tc = await trueCostData(orgId, { from: iso(from), to: iso(to), label: 'TTM' })
      rates = tc.departments.filter((d) => d.composite > 0).map((d) => ({ departmentId: d.id, ratePerHour: Math.round(d.composite * 100) / 100 }))
    }
    if (rates.length === 0) return NextResponse.json({ error: 'no rates to publish' }, { status: 400 })

    for (const r of rates) {
      // Close any open per-hour rows for the department so rates never stack
      // across periods, then start the new effective-dated row.
      await db.execute(sql`
        update overhead_rates set effective_to = (${effectiveFrom}::date - 1)
         where org_id = ${orgId} and department_id = ${r.departmentId} and rate_kind = 'per_hour'
           and (effective_to is null or effective_to >= ${effectiveFrom}::date)
           and effective_from < ${effectiveFrom}::date`)
      await db.execute(sql`
        delete from overhead_rates
         where org_id = ${orgId} and department_id = ${r.departmentId} and rate_kind = 'per_hour'
           and effective_from >= ${effectiveFrom}::date`)
      await db.execute(sql`
        insert into overhead_rates (org_id, department_id, category, method, rate_kind, rate_percent, effective_from, created_by, updated_by)
        values (${orgId}, ${r.departmentId}, 'Published', 'standard', 'per_hour', ${r.ratePerHour}, ${effectiveFrom}, ${gate.user.id}, ${gate.user.id})`)
    }
    return NextResponse.json({ ok: true, published: rates.length })
  }

  if (body.action === 'apply') {
    const typeIds: string[] = Array.isArray(body.projectTypeIds) ? body.projectTypeIds : []
    const overhead = body.overhead as FinancialProfile['overhead'] | undefined
    if (!typeIds.length || !overhead?.method) {
      return NextResponse.json({ error: 'projectTypeIds + overhead required' }, { status: 400 })
    }
    for (const id of typeIds) {
      await db.execute(sql`
        update project_types set financial_profile =
          jsonb_set(
            jsonb_set(
              jsonb_set(financial_profile, '{overhead}', ${JSON.stringify(overhead)}::jsonb),
              '{totalCost,components}',
              case when financial_profile->'totalCost'->'components' ? 'overhead' or ${overhead.method} = 'none'
                   then financial_profile->'totalCost'->'components'
                   else (financial_profile->'totalCost'->'components') || '"overhead"'::jsonb end),
            '{layout}',
            case when financial_profile->'layout' @> '[{"measure":"overhead"}]' or ${overhead.method} = 'none'
                 then financial_profile->'layout'
                 else (financial_profile->'layout') || '{"measure":"overhead","variant":"line"}'::jsonb end),
          updated_by = ${gate.user.id}, updated_at = now()
         where org_id = ${orgId} and id = ${id}`)
    }
    return NextResponse.json({ ok: true, applied: typeIds.length })
  }

  // How overhead reaches the ledger: report_only (statistical, default),
  // net_zero_pair (DR overhead acct [project] / CR same acct untagged —
  // P&L nets to zero), or off.
  if (body.action === 'set-application') {
    const mode = ['report_only', 'net_zero_pair', 'off'].includes(body.mode) ? body.mode : 'report_only'
    const accountId = body.accountId ?? null
    if (accountId !== null && !isUuid(accountId)) return NextResponse.json({ error: 'invalid accountId' }, { status: 422 })
    if (mode === 'net_zero_pair' && !accountId) return NextResponse.json({ error: 'net_zero_pair requires an overhead applied account' }, { status: 422 })
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{overheadApplication}',
        ${JSON.stringify({ mode, accountId })}::jsonb)
       where id = ${orgId}`)
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({ overheadApplication: { mode, accountId } })}, ${gate.user.id})`)
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'apply-period') {
    const { periodStart, periodEnd } = body
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd ?? '') || periodEnd < periodStart) {
      return NextResponse.json({ error: 'periodStart/periodEnd (YYYY-MM-DD) required' }, { status: 422 })
    }
    try {
      const result = await applyOverheadPairs({ orgId, actorId: gate.user.id, periodStart, periodEnd })
      return NextResponse.json({ ok: true, ...result })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 })
    }
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
