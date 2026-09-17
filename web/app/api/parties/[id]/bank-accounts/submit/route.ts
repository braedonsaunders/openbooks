import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/run.ts'
import { BANK_ACCOUNT_SUBJECT_KIND } from '@openbooks/engine/src/flows/bank-accounts-adapter.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { denyOutsidePartyScope } from '../route'

export const runtime = 'nodejs'

/**
 * Submit stale-pending bank details into the current approval flow
 * (F-t04-004 residual).
 *
 * How a bank record strands with no run: rows are born `pending` at create
 * (and re-enter it on material edit) while the approval flow is OPTIONAL —
 * with no enabled flow, runRecordFlows returns EMPTY and the engine never
 * sees the record. A flow authored later (or enabled later) does not
 * backfill: the row stays pending with no run and no gate, invisible to the
 * approvals centre, and the Approvals dialog truthfully reports no flow
 * history. The engine treats "no run" as "no approval required" — so the
 * only honest path forward is to dispatch the record through the CURRENT
 * flow now: the creation-side trigger re-planned against current values,
 * exactly what would have fired had the flow existed at create time.
 * Deliberately no auto-approve fallback (see the collection route): when no
 * enabled flow listens, the submit refuses with a typed message and the row
 * stays pending.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id: partyId } = await params

  const accountId = new URL(req.url).searchParams.get('accountId') ?? ''
  if (!isUuid(partyId) || !isUuid(accountId)) {
    return NextResponse.json({ error: 'bad ids' }, { status: 400 })
  }
  const partyDenied = await denyOutsidePartyScope(gate, partyId)
  if (partyDenied) return partyDenied

  // Lock the row through dispatch: two simultaneous submits serialize here,
  // and the loser sees the winner's live gate and refuses instead of
  // double-driving the flow.
  return withOrgTransaction(user.orgId, async () => {
    const existing = (await db.execute<{
      approvalStatus: string
      retiredAt: string | null
    }>(sql`
      select approval_status as "approvalStatus", retired_at as "retiredAt"
        from party_bank_accounts
       where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
       for update
    `))
    if (existing.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const account = existing.rows[0]!
    if (account.retiredAt) {
      return NextResponse.json(
        { error: 'retired bank details cannot be submitted for approval' },
        { status: 422 },
      )
    }
    if (account.approvalStatus !== 'pending') {
      return NextResponse.json(
        { error: 'only bank details awaiting approval can be submitted for approval' },
        { status: 422 },
      )
    }
    // Live gates own the record — deciding happens in the approvals centre.
    const live = (await db.execute<{ id: string }>(sql`
      select id from flow_gates
       where org_id = ${user.orgId}
         and subject_kind = ${BANK_ACCOUNT_SUBJECT_KIND}
         and subject_id = ${accountId}
         and status in ('pending', 'escalated')
       limit 1
    `))
    if (live.rows[0]) {
      return NextResponse.json(
        { error: 'these bank details are already awaiting approval — decide them in the approvals centre' },
        { status: 409 },
      )
    }
    const latest = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from flow_runs
       where org_id = ${user.orgId}
         and subject_kind = ${BANK_ACCOUNT_SUBJECT_KIND}
         and subject_id = ${accountId}
       order by started_at desc
       limit 1
    `)).rows[0]
    // A submit only (re-)drives a record whose runs are all terminal. A
    // failed latest run belongs to the retry path (same run row, resumed
    // idempotently); a running/waiting run is already driving the record.
    if (latest && latest.status !== 'completed' && latest.status !== 'cancelled') {
      if (latest.status === 'failed') {
        return NextResponse.json(
          { error: 'these bank details have a failed approval run — retry that run instead' },
          { status: 409 },
        )
      }
      return NextResponse.json(
        { error: 'an approval run is already in flight for these bank details' },
        { status: 409 },
      )
    }

    const flows = await runRecordFlows(
      { kind: 'on_create', source: 'ui' },
      BANK_ACCOUNT_SUBJECT_KIND,
      accountId,
      { orgId: user.orgId, userId: user.id },
    )
    if (flows.runs.length === 0 && !flows.failed) {
      return NextResponse.json(
        { error: 'no enabled approval flow handles new bank details — enable one, then submit again' },
        { status: 422 },
      )
    }
    const runId = flows.runs[0]?.runId ?? null
    if (flows.failed) {
      const errRow = runId
        ? (await db.execute<{ error: string | null }>(sql`
            select error from flow_runs where id = ${runId} and org_id = ${user.orgId}
          `)).rows[0]
        : null
      const detail = errRow?.error ?? 'bank-detail approval routing failed'
      // Fail closed like the collection PATCH: the row stays pending, and the
      // failed run is returned so the surface can offer the retry path.
      return NextResponse.json(
        { error: `these bank details could not enter the approval flow: ${detail}`, runId },
        { status: 422 },
      )
    }
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${user.orgId}, 'party_bank_accounts', ${accountId}, 'update',
        ${JSON.stringify({
          mode: 'bank_detail_submitted_to_flow',
          runId,
          gatesCreated: flows.gatesCreated,
        })}::jsonb,
        ${user.id}, 'ui'
      )
    `)
    return NextResponse.json({ id: accountId, approvalStatus: 'pending', runId, gatesCreated: flows.gatesCreated })
  })
}
