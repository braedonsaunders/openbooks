import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { computeTaxReturn } from '@openbooks/engine/src/tax-returns/return.ts'
import { buildTaxFilingSnapshot, TAX_FILING_SNAPSHOT_VERSION } from '@openbooks/engine/src/tax-returns/filing.ts'
import { loadOrgFilingCalendar } from '@openbooks/engine/src/tax/nexus-ledger.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { guardPermission, guardSubsidiaryScope, guardUnrestrictedScope } from '../../../../lib/authz'
import { parseReturnScopeBody, returnScopeOpts } from '@/lib/tax-return-scope'
import { TAX_FILING_WRITE_PERMISSION } from '../../../../lib/tax-filing-permission'

export const runtime = 'nodejs'

/**
 * Saving a snapshot (POST here) and marking it filed (PATCH [id]) both
 * certify a statutory position. The tax page derives its Save snapshot and
 * mark-filed affordances from this same symbol — never a second literal —
 * so a grant that can file always sees the action and one that cannot never
 * does.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

/** Filing obligations for the org's registrations in a date range. */
export async function GET(req: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardSubsidiaryScope(gate, null)
  if (scopeDenied) return scopeDenied
  const p = new URL(req.url).searchParams
  const today = await businessToday(gate.user.orgId)
  // A supplied date must be a REAL calendar date, not merely YYYY-MM-DD
  // shaped: the calendar builder normalizes 2026-02-30 to March and would
  // answer 200 with empty obligations instead of a named refusal. Absent
  // params still fall back to the defaults.
  for (const name of ['from', 'to'] as const) {
    const value = p.get(name)
    if (value !== null && !isIsoDate(value)) {
      return NextResponse.json({ error: `invalid ${name} date "${value}" (expected a real YYYY-MM-DD calendar date)` }, { status: 422 })
    }
  }
  const from = p.get('from') ?? `${today.slice(0, 4)}-01-01`
  const to = p.get('to') ?? today
  if (from > to) return NextResponse.json({ error: 'invalid period' }, { status: 422 })
  const obligations = await loadOrgFilingCalendar(gate.user.orgId, from, to)
  return NextResponse.json({ from, to, obligations })
}

/** Recompute server-side and freeze a versioned return snapshot in history. */
export async function POST(req: Request) {
  const gate = await guardPermission(TAX_FILING_WRITE_PERMISSION)
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    code?: string
    from?: string
    to?: string
    adjustments?: Record<string, string>
    filingEntity?: unknown
    translation?: unknown
  } | null
  if (!body?.code || !body.from || !body.to || !isIsoDate(body.from) || !isIsoDate(body.to)) {
    return NextResponse.json({ error: 'invalid return or period' }, { status: 422 })
  }
  if (body.from > body.to) return NextResponse.json({ error: 'invalid period' }, { status: 422 })
  if (body.adjustments !== undefined && (
    !body.adjustments || typeof body.adjustments !== 'object' || Array.isArray(body.adjustments) ||
    Object.keys(body.adjustments).length > 100 ||
    Object.entries(body.adjustments).some(([key, value]) => !key || typeof value !== 'string' || value.length > 100)
  )) return NextResponse.json({ error: 'invalid adjustments' }, { status: 422 })
  const adjustments = body.adjustments ?? {}
  // The filing scope parses with the SAME shared parser the preview GET
  // uses, so a scoped preview can always be frozen as prepared. An
  // explicitly scoped prepare stays inside the caller's allowed
  // subsidiaries; freezing the org-wide return is an org-wide write
  // (canonical shape 2), so restricted callers get the named 403.
  const parsedScope = parseReturnScopeBody({ filingEntity: body.filingEntity, translation: body.translation })
  if (parsedScope.error || !parsedScope.scope) {
    return NextResponse.json({ error: parsedScope.error ?? 'invalid scope' }, { status: 422 })
  }
  if (parsedScope.scope.subsidiaryIds.length > 0) {
    for (const id of parsedScope.scope.subsidiaryIds) {
      const denied = guardSubsidiaryScope(gate, id)
      if (denied) return denied
    }
  } else {
    const scopeDenied = guardUnrestrictedScope(gate)
    if (scopeDenied) return scopeDenied
  }

  try {
    const result = await computeTaxReturn(gate.user.orgId, body.code, body.from, body.to, adjustments, returnScopeOpts(parsedScope.scope))
    const editableCodes = new Set(result.boxes.filter((box) => box.editable).map((box) => box.lineCode))
    const normalizedAdjustments = Object.fromEntries(
      Object.entries(adjustments)
        .filter(([key, value]) => editableCodes.has(key) && value.trim() !== '')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value.trim()]),
    )
    const { snapshot, snapshotHash } = buildTaxFilingSnapshot(result, normalizedAdjustments)

    // The engine clamps the requested window to the registration's filing
    // period (result.from/result.to) and THAT window is the filing's stored
    // identity (tax_filings_period_version). The advisory lock and the version
    // must be derived from the same persisted key — never from the caller's
    // unclamped dates — or two prepares inside one quarter would compute the
    // same version and collide, and mark-filed (which locks on the stored
    // window) would serialize against nothing.
    const filing = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tax-filing:${gate.user.orgId}:${result.formCode}:${result.from}:${result.to}`}))`)
      const form = (await tx.execute<{ country: string | null }>(sql`
        select country from tax_return_forms
         where org_id = ${gate.user.orgId} and code = ${result.formCode} limit 1`))
      const versions = (await tx.execute<{ version: number }>(sql`
        select coalesce(max(version), 0)::int + 1 as version
          from tax_filings
         where org_id = ${gate.user.orgId} and form_code = ${result.formCode}
           and period_from = ${result.from} and period_to = ${result.to}`))
      const version = Number(versions.rows[0]?.version ?? 1)
      // The filing freezes the return's identity and currency posture
      // alongside its boxes: the export reprint and the mark-filed staleness
      // check read these columns, never the org's live configuration. An
      // org-wide (legacy-scope) return stores an empty scope, not NULL —
      // NULL means pre-snapshot (unknown scope, v1 semantics).
      const inserted = (await tx.execute<{ id: string; version: number }>(sql`
        insert into tax_filings
          (org_id, form_code, form_name, country, period_from, period_to, version,
           status, submission_channel, boxes, adjustments, snapshot_hash,
           functional_currency, presentation_currency, translation, subsidiary_ids,
           registration_id, registration_number, snapshot_version,
           created_by, updated_by)
        values (${gate.user.orgId}, ${result.formCode}, ${result.formName}, ${form.rows[0]?.country ?? null},
                ${result.from}, ${result.to}, ${version}, 'prepared', ${result.submissionChannel},
                ${JSON.stringify(snapshot.boxes)}::jsonb, ${JSON.stringify(normalizedAdjustments)}::jsonb,
                ${snapshotHash},
                ${result.functionalCurrency}, ${result.translation?.presentationCurrency ?? null},
                ${result.translation ? JSON.stringify(result.translation) : null}::jsonb,
                ${`{${result.subsidiaryIds.join(',')}}`}::uuid[],
                ${result.registrationId}, ${result.registrationNumber}, ${TAX_FILING_SNAPSHOT_VERSION},
                ${gate.user.id}, ${gate.user.id})
        returning id, version`))
      const row = inserted.rows[0]!
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'tax_filings', ${row.id}, 'insert',
                ${JSON.stringify({ status: 'prepared', formCode: result.formCode, from: result.from, to: result.to, version, snapshotHash, snapshotVersion: TAX_FILING_SNAPSHOT_VERSION })}::jsonb,
                ${gate.user.id})`)
      return row
    })
    // The creation response exposes the persisted filing window, not the requested range.
    return NextResponse.json(
      { ...filing, formCode: result.formCode, from: result.from, to: result.to },
      { status: 201 },
    )
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'could not save filing' }, { status: 422 })
  }
}
