import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import type { FinancialProfile } from '@openbooks/schema'
import { backfillOverhead } from '@openbooks/engine/src/projects/overhead-apply.ts'
import { syncOverheadSystemRule } from '@openbooks/engine/src/allocations/overhead-sync.ts'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import { publishProjectFinancialProfileInTransaction } from '@openbooks/engine/src/projects/financial-profile-versions.ts'
import { isUuid } from '../../../../../lib/list-params'
import { guardPermission, guardUnrestrictedScope, subsidiariesInScope } from '../../../../../lib/authz'
import { acquireFeatureGateLock } from '../../../../../lib/features'
import { publishOverheadRates } from '../../../../../lib/overhead-publish'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'
import { canonicalDecimal, compareDecimal } from '../../../../../lib/exact-decimal'
import { isCalendarDate } from '../../../../../lib/setup/coerce'

export const dynamic = 'force-dynamic'

/** Keep the handler's full action inventory here so each write's ownership
 * decision stays explicit: only a department-targeted publish is
 * entity-owned; every other supported action writes org-wide policy/state. */
function requiresUnrestrictedOverheadScope(body: Record<string, unknown>): boolean {
  switch (body.action) {
    case 'publish':
      return !Array.isArray(body.rates) || body.rates.length === 0
    case 'apply':
    case 'set-lifecycle':
    case 'set-application':
    case 'backfill-overhead':
      return true
    default:
      return false
  }
}

/** Whole-digit width of a canonical decimal: numeric(19,4) holds 15. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

/** Drizzle/node-postgres may expose the server error directly or as `cause`. */
function postgresErrorCode(error: unknown): string | undefined {
  let current = error
  while (current && typeof current === 'object') {
    const candidate = current as { code?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string') return candidate.code
    current = candidate.cause
  }
  return undefined
}

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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (requiresUnrestrictedOverheadScope(body)) {
    const scopeDenied = guardUnrestrictedScope(gate)
    if (scopeDenied) return scopeDenied
  }

  if (body.action === 'publish') {
    const effectiveFrom = typeof body.effectiveFrom === 'string' ? body.effectiveFrom : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom ?? '') || !isCalendarDate(effectiveFrom)) {
      return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) required' }, { status: 400 })
    }
    const rates: { departmentId: string; ratePerHour: string }[] = []
    if (Array.isArray(body.rates)) {
      for (const r of body.rates as { departmentId: string; ratePerHour: string | number }[]) {
        // Department identity belongs to the publisher (which fails closed
        // on unknown ids through its foreign key): the route only requires
        // a present reference and exact money, so validation shapes the
        // payload without second-guessing the department registry.
        if (typeof r.departmentId !== 'string' || !r.departmentId) {
          return NextResponse.json({ error: 'departmentId is required' }, { status: 400 })
        }
        const exact = canonicalDecimal(r.ratePerHour, 4)
        if (exact === null || compareDecimal(exact, '0') < 0) {
          return NextResponse.json({ error: 'ratePerHour must be a non-negative amount' }, { status: 400 })
        }
        // overhead_rates.rate_percent is numeric(19,4): refuse whole-digit
        // widths the column cannot hold before any write, instead of throwing
        // the raw overflow out of the publish.
        if (wholeDigits(exact) > 15) {
          return NextResponse.json({ error: 'ratePerHour must fit within numeric(19,4)' }, { status: 400 })
        }
        rates.push({ departmentId: r.departmentId, ratePerHour: exact })
      }
    }
    try {
      if (gate.allowedSubsidiaryIds) {
        if (rates.length === 0) {
          // The route-level ownership classification requires unrestricted
          // access before this org-wide publish-all branch.
        } else {
          // Every department in the publish must sit in the actor's scope
          // (departments.subsidiary_id): a restricted admin cannot replace
          // another entity's effective-dated rates.
          const wanted = [...new Set(rates.map((r) => r.departmentId))]
          const found = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
            select id, subsidiary_id from departments
             where org_id = ${orgId} and id = any(${`{${wanted.join(',')}}`}::uuid[])
          `)).rows
          // Unknown and out-of-scope departments answer identically: the two
          // cases are indistinguishable, so a restricted caller cannot probe
          // another subsidiary's departments by id.
          if (found.length !== wanted.length
            || !subsidiariesInScope(gate, found.map((row) => row.subsidiary_id))) {
            return NextResponse.json(
              { error: 'unknown or out-of-scope department — publish only departments in your visible subsidiaries or ask an administrator for access' },
              { status: 422 },
            )
          }
        }
      }
      const result = await publishOverheadRates(orgId, gate.user.id, effectiveFrom, rates.length ? rates : undefined)
      if (result.published === 0) return NextResponse.json({ error: 'no rates to publish' }, { status: 400 })
      return NextResponse.json({ ok: true, published: result.published })
    } catch (e) {
      // A malformed or unknown department id surfaces as a Postgres input
      // (22P02) or foreign-key (23503) throw. Refuse the publish as a
      // request-state failure instead of a raw 500; anything else (overlap
      // guard, engine errors) keeps its existing behavior.
      const code = postgresErrorCode(e)
      if (code === '22P02' || code === '23503') {
        return NextResponse.json({ error: 'unknown department' }, { status: 422 })
      }
      throw e
    }
  }

  if (body.action === 'apply') {
    const typeIds: string[] = Array.isArray(body.projectTypeIds) ? body.projectTypeIds : []
    const overhead = body.overhead as FinancialProfile['overhead'] | undefined
    const effectiveFrom = String(body.effectiveFrom ?? '')
    const reason = String(body.reason ?? '').trim()
    if (!typeIds.length || !overhead?.method) {
      return NextResponse.json({ error: 'projectTypeIds + overhead required' }, { status: 400 })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || !isCalendarDate(effectiveFrom)) {
      return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) required' }, { status: 400 })
    }
    if (typeIds.some((id) => !isUuid(id))) {
      return NextResponse.json({ error: 'invalid projectTypeId' }, { status: 422 })
    }
    try {
      await db.transaction(async (tx) => {
        for (const id of typeIds) {
          const current = (await tx.execute<{ financial_profile: FinancialProfile }>(sql`
            select version.financial_profile as financial_profile
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
          `))
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
    const mode = body.mode === undefined ? 'manual' : body.mode
    if (mode !== 'manual' && mode !== 'scheduled' && mode !== 'live') {
      return NextResponse.json({ error: 'invalid mode' }, { status: 422 })
    }
    // Omission keeps the documented defaults; a SUPPLIED value outside the
    // enum is a different policy than requested, not a default — refuse it
    // before any write rather than silently storing manual/monthly.
    const cadence = body.cadence === undefined ? 'monthly' : body.cadence
    if (cadence !== 'monthly' && cadence !== 'quarterly') {
      return NextResponse.json({ error: 'invalid cadence' }, { status: 422 })
    }
    // Existing lock order: feature-gate fence first, then the authoritative
    // feature recheck, then the org row lock, then the write. Settings and
    // the locked before/after audit evidence commit in ONE transaction: a
    // failure past the write rolls the policy back, never an unevidenced
    // change.
    const lifecycleDenied = await withOrgTransaction(orgId, async () => {
      await acquireFeatureGateLock(orgId)
      if (!(await lockAndCheckOrgFeature(db, orgId, 'projects'))) {
        return NextResponse.json({ error: 'projects feature is disabled' }, { status: 404 })
      }
      const current = await db.execute<{ settings: Record<string, unknown> | null }>(sql`
        select settings from orgs where id = ${orgId} for update`)
      const before = (current.rows[0]?.settings as Record<string, unknown> | undefined)?.overheadRateLifecycle ?? null
      const after = { mode, cadence }
      await db.execute(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{overheadRateLifecycle}',
          ${JSON.stringify(after)}::jsonb)
         where id = ${orgId}`)
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'orgs', ${orgId}, 'update',
                ${JSON.stringify({ overheadRateLifecycle: { before, after } })}, ${gate.user.id})`)
      return null
    })
    if (lifecycleDenied) return lifecycleDenied
    return NextResponse.json({ ok: true })
  }

  // How overhead reaches the ledger: report_only (statistical, default),
  // net_zero_pair (DR overhead acct [project] / CR same acct untagged —
  // P&L nets to zero), or off.
  if (body.action === 'set-application') {
    // Omission keeps the documented default; a SUPPLIED value outside the
    // enum is a different policy than requested — refuse it before any write.
    const mode = body.mode === undefined ? 'report_only' : body.mode
    if (mode !== 'report_only' && mode !== 'net_zero_pair' && mode !== 'off') {
      return NextResponse.json({ error: 'invalid mode' }, { status: 422 })
    }
    const accountId = body.accountId ?? null
    if (accountId !== null && (typeof accountId !== 'string' || !isUuid(accountId))) return NextResponse.json({ error: 'invalid accountId' }, { status: 422 })
    if (mode === 'net_zero_pair' && !accountId) return NextResponse.json({ error: 'net_zero_pair requires an overhead applied account' }, { status: 422 })
    // Existing lock order: feature-gate fence first, then the authoritative
    // feature recheck, then row locks (org settings, then the referenced
    // account shared), then the write. A referenced account must be a real,
    // ACTIVE posting account in this org: the pair posts to it at
    // time-approval, so a dangling id would only move the failure into the
    // ledger (same boundary as labor-costing PUT and the payment-providers
    // surcharge rule save). The locked before/after evidence commits with the
    // settings or not at all.
    const applicationDenied = await withOrgTransaction(orgId, async () => {
      await acquireFeatureGateLock(orgId)
      if (!(await lockAndCheckOrgFeature(db, orgId, 'projects'))) {
        return NextResponse.json({ error: 'projects feature is disabled' }, { status: 404 })
      }
      const current = await db.execute<{ settings: Record<string, unknown> | null }>(sql`
        select settings from orgs where id = ${orgId} for update`)
      if (accountId !== null) {
        const found = await db.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${orgId} and id = ${accountId} and not is_summary and is_active
           limit 1 for share`)
        if (!found.rows[0]) {
          return NextResponse.json(
            { error: 'overhead applied account not found, inactive, or is a summary account' },
            { status: 422 },
          )
        }
      }
      const before = (current.rows[0]?.settings as Record<string, unknown> | undefined)?.overheadApplication ?? null
      const after = { mode, accountId }
      await db.execute(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{overheadApplication}',
          ${JSON.stringify(after)}::jsonb)
         where id = ${orgId}`)
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'orgs', ${orgId}, 'update',
                ${JSON.stringify({ overheadApplication: { before, after } })}, ${gate.user.id})`)
      // The kernel's system rule mirrors this policy: derive it in the same
      // transaction (this block already runs inside the org boundary).
      await syncOverheadSystemRule(orgId, gate.user.id)
      return null
    })
    if (applicationDenied) return applicationDenied
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
