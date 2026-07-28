import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FinancialProfile } from '@openbooks/schema'
import { backfillOverhead } from '@openbooks/engine/src/overhead-apply.ts'
import { publishProjectFinancialProfileInTransaction } from '@openbooks/engine/src/project-financial-profile-versions.ts'
import { isUuid } from '../../../../../lib/list-params'
import { guardPermission } from '../../../../../lib/authz'
import { publishOverheadRates } from '../../../../../lib/overhead-publish'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'

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
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  const body = await req.json().catch(() => ({}))

  if (body.action === 'publish') {
    const effectiveFrom: string = body.effectiveFrom
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom ?? '')) {
      return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) required' }, { status: 400 })
    }
    const rates: { departmentId: string; ratePerHour: number }[] = Array.isArray(body.rates) ? body.rates : []
    const result = await publishOverheadRates(orgId, gate.user.id, effectiveFrom, rates.length ? rates : undefined)
    if (result.published === 0) return NextResponse.json({ error: 'no rates to publish' }, { status: 400 })
    return NextResponse.json({ ok: true, published: result.published })
  }

  if (body.action === 'apply') {
    const typeIds: string[] = Array.isArray(body.projectTypeIds) ? body.projectTypeIds : []
    const overhead = body.overhead as FinancialProfile['overhead'] | undefined
    const effectiveFrom = String(body.effectiveFrom ?? '')
    const reason = String(body.reason ?? '').trim()
    if (!typeIds.length || !overhead?.method) {
      return NextResponse.json({ error: 'projectTypeIds + overhead required' }, { status: 400 })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) required' }, { status: 400 })
    }
    if (typeIds.some((id) => !isUuid(id))) {
      return NextResponse.json({ error: 'invalid projectTypeId' }, { status: 422 })
    }
    try {
      await db.transaction(async (tx) => {
        for (const id of typeIds) {
          const current = (await tx.execute(sql`
            select coalesce(version.financial_profile, pt.financial_profile) as financial_profile
              from project_types pt
              left join lateral (
                select v.financial_profile
                  from project_financial_profile_versions v
                 where v.org_id = pt.org_id
                   and v.project_type_id = pt.id
                   and v.effective_from <= ${effectiveFrom}
                   and (v.effective_to is null or v.effective_to >= ${effectiveFrom})
                 order by v.effective_from desc
                 limit 1
              ) version on true
             where pt.org_id = ${orgId} and pt.id = ${id}
             for update of pt
          `)) as unknown as { rows: { financial_profile: FinancialProfile }[] }
          const profile = current.rows[0]?.financial_profile
          if (!profile) throw new Error('project type not found')
          const components = profile.totalCost.components.includes('overhead') || overhead.method === 'none'
            ? profile.totalCost.components
            : [...profile.totalCost.components, 'overhead' as const]
          const layout = overhead.method === 'none'
            ? profile.layout
            : (() => {
                const overheadLine = profile.layout.find((line) => line.measure === 'overhead')
                  ?? { measure: 'overhead' as const, variant: 'line' as const }
                const withoutOverhead = profile.layout.filter((line) => line.measure !== 'overhead')
                const totalCostIndex = withoutOverhead.findIndex((line) => line.measure === 'total_cost')
                return totalCostIndex >= 0
                  ? [
                      ...withoutOverhead.slice(0, totalCostIndex),
                      overheadLine,
                      ...withoutOverhead.slice(totalCostIndex),
                    ]
                  : [...withoutOverhead, overheadLine]
              })()
          await publishProjectFinancialProfileInTransaction(tx, {
            orgId,
            projectTypeId: id,
            effectiveFrom,
            financialProfile: {
              ...profile,
              overhead,
              totalCost: { components },
              layout,
            },
            reason,
            actorId: gate.user.id,
          })
        }
      })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 })
    }
    return NextResponse.json({ ok: true, applied: typeIds.length })
  }

  // Rate lifecycle: who maintains the published card — manual (a human
  // publishes), scheduled (the worker publishes each period), live (project
  // types read the live engine; the card is advisory).
  if (body.action === 'set-lifecycle') {
    const mode = ['manual', 'scheduled', 'live'].includes(body.mode) ? body.mode : 'manual'
    const cadence = ['monthly', 'quarterly'].includes(body.cadence) ? body.cadence : 'monthly'
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{overheadRateLifecycle}',
        ${JSON.stringify({ mode, cadence })}::jsonb)
       where id = ${orgId}`)
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({ overheadRateLifecycle: { mode, cadence } })}, ${gate.user.id})`)
    return NextResponse.json({ ok: true })
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

  // Overhead applies automatically as hours are approved; backfill only
  // carries hours approved before the mode was enabled (or imported).
  if (body.action === 'backfill-overhead') {
    try {
      const result = await backfillOverhead(orgId, gate.user.id)
      return NextResponse.json({ ok: true, ...result })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 })
    }
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
