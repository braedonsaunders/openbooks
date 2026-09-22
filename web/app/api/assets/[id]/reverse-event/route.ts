import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { reverseAssetLifecycleEvent } from '@openbooks/engine/src/assets/asset-lifecycle.ts'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

const REVERSIBLE_KINDS = ['revalued', 'impaired', 'disposed', 'written_off'] as const

type BlockReason =
  | 'already_reversed'
  | 'accounting_change'
  | 'entry_not_posted'
  | 'later_event'
  | 'no_reversal_workflow'

function subsidiaryFence(allowedSubsidiaryIds: Set<string> | null) {
  return allowedSubsidiaryIds
    ? sql`and asset.subsidiary_id = any(${`{${[...allowedSubsidiaryIds].join(',')}}`}::uuid[])`
    : sql``
}

async function visibleAsset(orgId: string, id: string, allowedSubsidiaryIds: Set<string> | null) {
  const asset = (await db.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id from fixed_assets asset where org_id = ${orgId} and id = ${id} ${subsidiaryFence(allowedSubsidiaryIds)}`)).rows[0]
  if (!asset) return null
  return asset
}

/** Reversible-event candidates for the asset; advisory only, the engine
 *  decides on POST. The history read carries the subsidiary fence. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid asset' }, { status: 422 })
  if (!await visibleAsset(gate.user.orgId, id, gate.allowedSubsidiaryIds)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const rows = (await db.execute<{
    id: string
    kind: string
    occurred_on: string
    amount: string | null
    financial_change_id: string | null
    entry_number: string
    posting_date: string
    entry_status: string
    reversed: boolean
    later_kind: string | null
  }>(sql`
    select event.id, event.kind, event.occurred_on::text as occurred_on,
           event.amount::text as amount, event.financial_change_id,
           entry.entry_number, entry.posting_date::text as posting_date,
           entry.status as entry_status,
           exists (select 1 from asset_events reversal
                    where reversal.org_id = event.org_id
                      and reversal.reverses_event_id = event.id) as reversed,
           (select later.kind from asset_events later
             where later.org_id = event.org_id
               and later.asset_id = event.asset_id
               and later.id <> event.id
               and later.reverses_event_id is null
               and later.created_at >= event.created_at
               and not exists (
                 select 1 from asset_events reversal
                  where reversal.org_id = later.org_id
                    and reversal.reverses_event_id = later.id
               )
             order by later.created_at
             limit 1) as later_kind
      from asset_events event
      join journal_entries entry
        on entry.id = event.journal_entry_id and entry.org_id = event.org_id
      join fixed_assets asset
        on asset.id = event.asset_id and asset.org_id = event.org_id
     where event.org_id = ${gate.user.orgId} and event.asset_id = ${id} ${subsidiaryFence(gate.allowedSubsidiaryIds)}
     order by event.occurred_on desc, event.created_at desc`)).rows

  return NextResponse.json({
    events: rows.map((row) => {
      let blockReason: BlockReason | null = null
      if (row.reversed) blockReason = 'already_reversed'
      else if (row.financial_change_id) blockReason = 'accounting_change'
      else if (!(REVERSIBLE_KINDS as readonly string[]).includes(row.kind)) blockReason = 'no_reversal_workflow'
      else if (row.entry_status !== 'posted') blockReason = 'entry_not_posted'
      else if (row.later_kind) blockReason = 'later_event'
      return {
        id: row.id,
        kind: row.kind,
        occurredOn: row.occurred_on,
        amount: row.amount,
        entryNumber: row.entry_number,
        postingDate: row.posting_date,
        entryStatus: row.entry_status,
        reversible: blockReason === null,
        blockReason,
        laterKind: row.later_kind,
      }
    }),
  })
}

/** Reverse a posted disposal or remeasurement via the engine; change-owned
 *  events stay on Accounting changes. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid asset' }, { status: 422 })
  if (!await visibleAsset(gate.user.orgId, id, gate.allowedSubsidiaryIds)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { eventId?: string; date?: string; reason?: string }
  if (!body.eventId || !isUuid(body.eventId)) {
    return NextResponse.json({ error: 'select the lifecycle event to reverse' }, { status: 422 })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 8 || reason.length > 500) {
    return NextResponse.json({ error: 'a reversal reason between 8 and 500 characters is required' }, { status: 422 })
  }
  if (body.date !== undefined && !isIsoCalendarDate(body.date)) {
    return NextResponse.json({ error: 'date must be a valid calendar date (YYYY-MM-DD)' }, { status: 422 })
  }
  const date = body.date === undefined ? await businessToday(gate.user.orgId) : body.date

  try {
    const result = await reverseAssetLifecycleEvent(gate.user.orgId, body.eventId, {
      date,
      actorId: gate.user.id,
      reason,
      assetId: id,
      ...(gate.allowedSubsidiaryIds ? { allowedSubsidiaryIds: [...gate.allowedSubsidiaryIds] } : {}),
    })
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'reversal failed' }, { status: 422 })
  }
}
