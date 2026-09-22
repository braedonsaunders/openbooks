import { z } from 'zod'
import { isoDate, parseJsonBody, uuidId } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { ClosedBatchError, previewDepreciation, runDepreciation, StalePreviewError } from '@openbooks/engine/src/assets/depreciation.ts'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

// Typed body (never jsonObject: the financial-boundary ceiling only shrinks).
// Legacy immediate runs ({assetId?, bookId?}) keep working; the review drawer
// confirms with {assetIds, fingerprint} plus the shared scope fields, so the
// server revalidates the exact previewed set under the stale-input fence.
const runBody = z.object({
  asOfDate: isoDate().optional(),
  assetId: uuidId.optional(),
  bookId: uuidId.optional(),
  periodId: z.string().optional().nullable(),
  postingDate: isoDate().optional(),
  assetIds: z.array(z.string()).optional(),
  fingerprint: z.string().optional(),
})

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status });
}

/**
 * Run depreciation: recognize due book amounts idempotently. GL-posting books
 * use the kernel; reporting-only books retain audited subledger evidence.
 *
 * Confirm path (review drawer): revalidates the previewed selection — book,
 * period, tenant-owned asset ids — recomputes the preview fingerprint over
 * current state, and refuses stale, schedule-stale, or empty selections by
 * name. Posting runs as one all-or-nothing batch in a single outer
 * transaction: the fingerprint is recompared under held locks, then every
 * line validates before any recognition or journal write issues. Drift, a
 * closed period, or a config refusal aborts the whole batch (409) — drift
 * is never downgraded to per-line skips.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const parsedBody = await parseJsonBody(req, runBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const asOfDate = body.asOfDate ?? await businessToday(user.orgId)
  if (!isIsoCalendarDate(asOfDate)) {
    return bad('invalid_through_date', 'asOfDate')
  }

  const isConfirm =
    body.fingerprint !== undefined || body.assetIds !== undefined || body.periodId !== undefined
  if (!isConfirm) {
    try {
      const result = await runDepreciation(
        user.orgId,
        asOfDate,
        user.id,
        body.assetId,
        gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
        body.bookId,
      )
      return NextResponse.json(result)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  const fingerprint = body.fingerprint?.trim() || ''
  if (!fingerprint) {
    return bad('fingerprint_required', 'fingerprint')
  }
  const rawIds = body.assetIds ?? []
  const assetIds = [...new Set(rawIds.map((id) => id.trim().toLowerCase()).filter(Boolean))]
  if (assetIds.length === 0) {
    return bad('nothing_selected', 'assetIds')
  }
  if (assetIds.some((id) => !isUuid(id))) return bad('unknown_asset', 'assetIds')

  const bookId = body.bookId ?? null
  if (bookId) {
    const book = await db.execute(sql`
      select 1 from accounting_books
       where id = ${bookId} and org_id = ${user.orgId} and is_active
    `)
    if (!book.rows[0]) return bad('book_not_found', 'bookId')
  }
  const periodId = body.periodId?.trim().toLowerCase() || null
  if (periodId) {
    if (!isUuid(periodId)) return bad('period_not_found', 'periodId')
    const period = await db.execute(sql`
      select 1 from accounting_periods
       where id = ${periodId} and org_id = ${user.orgId} and not is_adjustment
    `)
    if (!period.rows[0]) return bad('period_not_found', 'periodId')
  }

  // Tenant-owned and reader-visible, or the selection names nothing: a
  // foreign or out-of-scope id refuses rather than silently narrowing.
  const owned = await db.execute<{ id: string }>(sql`
    select a.id from fixed_assets a
     where a.org_id = ${user.orgId} and a.id = any(${`{${assetIds.join(",")}}`}::uuid[])
       ${gate.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
  `)
  const seen = new Set(owned.rows.map((row) => String(row.id).toLowerCase()))
  if (assetIds.some((id) => !seen.has(id))) return bad('unknown_asset', 'assetIds')

  const scope = {
    asOfDate,
    bookId: bookId ?? undefined,
    periodId: periodId ?? undefined,
    assetIds,
  }
  let preview: Awaited<ReturnType<typeof previewDepreciation>>
  try {
    preview = await previewDepreciation(user.orgId, {
      ...scope,
      postingDate: body.postingDate ?? undefined,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
  if (preview.fingerprint !== fingerprint) {
    return NextResponse.json(
      { error: 'stale_preview' },
      { status: 409 },
    )
  }
  // A stored-line preview over a stale schedule silently omits due months
  // that rollover has not projected yet: refuse by name with the remedy
  // (rebuild, then preview again) instead of posting a partial as-of set.
  if (preview.staleAssets.length > 0) {
    return NextResponse.json(
      {
        error: 'schedules_stale',
        assets: preview.staleAssets.map((asset) => ({
          assetId: asset.assetId,
          assetNumber: asset.assetNumber,
          assetName: asset.assetName,
        })),
      },
      { status: 409 },
    )
  }
  if (preview.rows.length === 0) {
    return bad('nothing_due', 'assetIds')
  }

  try {
    const result = await runDepreciation(
      user.orgId,
      asOfDate,
      user.id,
      undefined,
      gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
      bookId ?? undefined,
      {
        assetIds,
        periodId: periodId ?? undefined,
        postingDate: body.postingDate ?? preview.postingDate ?? undefined,
        lineIds: preview.rows.map((row) => row.lineId),
        expectedFingerprint: fingerprint,
        expectedLines: preview.rows.map((row) => ({
          lineId: row.lineId,
          assetId: row.assetId,
          amount: row.amount,
          periodId: row.periodId,
          bookId: row.bookId,
          debitAccountId: row.debitAccountId,
          creditAccountId: row.creditAccountId,
          subsidiaryId: row.subsidiaryId,
          departmentId: row.departmentId,
          projectId: row.projectId,
          locationId: row.locationId,
          evidence: row.evidence,
        })),
      },
    )
    return NextResponse.json({ ...result, fingerprint })
  } catch (e: unknown) {
    // The all-or-nothing batch found drift under its held locks: refuse the
    // whole batch like a stale preview — nothing was written.
    if (e instanceof StalePreviewError) {
      return NextResponse.json({ error: 'stale_preview' }, { status: 409 })
    }
    // A closed in-scope period aborts the batch the same way: open the
    // period, then confirm again. Never a partial post plus skips.
    if (e instanceof ClosedBatchError) {
      return NextResponse.json(
        { error: 'period_closed', asset: e.assetNumber, period: e.periodName },
        { status: 409 },
      )
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
