import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { computeTaxReturn } from '@openbooks/engine/src/tax-return.ts'
import { loadOrgFilingCalendar } from '@openbooks/engine/src/tax-nexus-ledger.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

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
  const p = new URL(req.url).searchParams
  const today = await businessToday(gate.user.orgId)
  const from = p.get('from') && DATE_RE.test(p.get('from')!) ? p.get('from')! : `${today.slice(0, 4)}-01-01`
  const to = p.get('to') && DATE_RE.test(p.get('to')!) ? p.get('to')! : today
  if (from > to) return NextResponse.json({ error: 'invalid period' }, { status: 422 })
  const obligations = await loadOrgFilingCalendar(gate.user.orgId, from, to)
  return NextResponse.json({ from, to, obligations })
}

/** Recompute server-side and freeze a versioned return snapshot in history. */
export async function POST(req: Request) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    code?: string
    from?: string
    to?: string
    adjustments?: Record<string, string>
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

  try {
    const result = await computeTaxReturn(gate.user.orgId, body.code, body.from, body.to, adjustments)
    const editableCodes = new Set(result.boxes.filter((box) => box.editable).map((box) => box.lineCode))
    const normalizedAdjustments = Object.fromEntries(
      Object.entries(adjustments)
        .filter(([key, value]) => editableCodes.has(key) && value.trim() !== '')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value.trim()]),
    )
    const snapshot = {
      formCode: result.formCode,
      formName: result.formName,
      from: result.from,
      to: result.to,
      submissionChannel: result.submissionChannel,
      boxes: result.boxes.map(({ pdfField: _pdfField, ...box }) => box),
      adjustments: normalizedAdjustments,
    }
    const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')

    const filing = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tax-filing:${gate.user.orgId}:${body.code}:${body.from}:${body.to}`}))`)
      const form = (await tx.execute<{ country: string | null }>(sql`
        select country from tax_return_forms
         where org_id = ${gate.user.orgId} and code = ${body.code} limit 1`))
      const versions = (await tx.execute<{ version: number }>(sql`
        select coalesce(max(version), 0)::int + 1 as version
          from tax_filings
         where org_id = ${gate.user.orgId} and form_code = ${body.code}
           and period_from = ${body.from} and period_to = ${body.to}`))
      const version = Number(versions.rows[0]?.version ?? 1)
      const inserted = (await tx.execute<{ id: string; version: number }>(sql`
        insert into tax_filings
          (org_id, form_code, form_name, country, period_from, period_to, version,
           status, submission_channel, boxes, adjustments, snapshot_hash,
           created_by, updated_by)
        values (${gate.user.orgId}, ${result.formCode}, ${result.formName}, ${form.rows[0]?.country ?? null},
                ${result.from}, ${result.to}, ${version}, 'prepared', ${result.submissionChannel},
                ${JSON.stringify(snapshot.boxes)}::jsonb, ${JSON.stringify(normalizedAdjustments)}::jsonb,
                ${snapshotHash}, ${gate.user.id}, ${gate.user.id})
        returning id, version`))
      const row = inserted.rows[0]
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'tax_filings', ${row.id}, 'insert',
                ${JSON.stringify({ status: 'prepared', formCode: result.formCode, from: result.from, to: result.to, version, snapshotHash })}::jsonb,
                ${gate.user.id})`)
      return row
    })
    return NextResponse.json(filing, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'could not save filing' }, { status: 422 })
  }
}
