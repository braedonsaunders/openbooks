import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { runDueSftpImports } from '@openbooks/engine/src/sftp/import-job.ts'
import { SFTP_UNBOUND_SCHEDULE_NOTICE_KIND, sftpUnboundScheduleNoticeHref } from '@openbooks/engine/src/sftp/schedule-notice.ts'
import { normalizeExternalAccountId } from '@openbooks/engine/src/banking/banking.ts'
import { auditSetupChange } from '../../../../../../lib/setup/audit'
import { randomUUID } from 'node:crypto'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { guardSubsidiaryScope, type Authz } from '../../../../../../lib/authz'

export const runtime = 'nodejs'
const requestId = (req: Request) => req.headers.get('x-request-id')?.trim() || randomUUID()

function scheduleAuditSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  return {
    sftp_server_id: row.sftp_server_id,
    account_id: row.account_id,
    format: row.format,
    folder: row.folder,
    csv_mapping: row.csv_mapping,
    expected_external_account_id: row.expected_external_account_id,
    is_active: row.is_active,
    created_by: row.created_by,
    updated_by: row.updated_by,
  }
}

/**
 * Refuse a manual run the engine did not execute. Mirrors the exclusion
 * predicate in `runDueSftpImports` (schedule active, server active,
 * production org, bank feeds on) and names the first failing condition with
 * its real remedy: schedule reactivation is PATCH `{ isActive: true }` on
 * this route, server reactivation is PATCH `{ action: 'toggle' }` on the
 * server route, bank feeds turn on at Company Settings → Features, and a
 * deleted server means replacing the schedule (DELETE here, POST on the
 * collection). When every condition still holds the scan raced a concurrent
 * change, so say so and ask for a retry rather than claiming a clean scan.
 * The predicate stays org-scoped, so foreign ids keep reading as 'not
 * found' exactly like the ownership check above.
 */
async function refuseUnexecutedRun(scheduleId: string, orgId: string): Promise<NextResponse> {
  const diagnosis = (await db.execute<{
    schedule_active: boolean
    server_id: string | null
    server_active: boolean | null
    env_kind: string
    feeds_on: boolean
  }>(sql`
    select sc.is_active as schedule_active,
           sv.id as server_id,
           sv.is_active as server_active,
           o.env_kind,
           -- Registry fallback shape (non-boolean stored values fall back to
           -- the default instead of throwing 22P02).
           case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end as feeds_on
      from sftp_import_schedules sc
      left join sftp_servers sv on sv.id = sc.sftp_server_id and sv.org_id = sc.org_id
      join orgs o on o.id = sc.org_id
     where sc.id = ${scheduleId} and sc.org_id = ${orgId}
  `))
  const row = diagnosis.rows[0]
  // Deleted between the ownership check and the scan: same answer as never
  // owned, never a fabricated result.
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!row.schedule_active) {
    return NextResponse.json(
      { error: 'Activate this schedule before running it.', code: 'SCHEDULE_INACTIVE' },
      { status: 409 },
    )
  }
  if (!row.server_id) {
    return NextResponse.json(
      { error: 'The SFTP server for this schedule no longer exists — delete this schedule and create a new one on an active server.', code: 'SFTP_SERVER_MISSING' },
      { status: 409 },
    )
  }
  if (!row.server_active) {
    return NextResponse.json(
      { error: 'Activate the SFTP server before running this schedule.', code: 'SFTP_SERVER_INACTIVE' },
      { status: 409 },
    )
  }
  if (row.env_kind !== 'production') {
    return NextResponse.json(
      { error: 'Manual SFTP runs are available only in production organizations.', code: 'SFTP_RUN_NON_PRODUCTION' },
      { status: 409 },
    )
  }
  if (!row.feeds_on) {
    return NextResponse.json(
      { error: 'Bank feeds are disabled — enable bank feeds in Company Settings → Features before running.', code: 'BANK_FEEDS_DISABLED' },
      { status: 409 },
    )
  }
  return NextResponse.json(
    { error: 'The schedule changed while the run was starting — try running it again.', code: 'SCHEDULE_RUN_STALE' },
    { status: 409 },
  )
}

/**
 * Scope-gate a schedule by its bound bank account's owning subsidiary.
 * Callers check existence first (their own 404); a deleted account fails
 * closed the same way as an out-of-scope one.
 */
async function requireScheduleScope(authz: Authz, scheduleId: string): Promise<NextResponse | null> {
  const row = (await db.execute<{ subsidiary_id: string | null }>(sql`
    select a.subsidiary_id
      from sftp_import_schedules sc
      join accounts a on a.id = sc.account_id and a.org_id = sc.org_id
     where sc.id = ${scheduleId} and sc.org_id = ${authz.user.orgId}
  `)).rows[0]
  return guardSubsidiaryScope(authz, row?.subsidiary_id ?? null)
}

/** Toggle active, or run the schedule now: { action: 'run' } / { isActive }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string; isActive?: boolean; expectedExternalAccountId?: unknown }
  // Binding update: (re)bind the one external account identifier this
  // schedule accepts. Stored canonical; an explicit null clears the
  // binding (identified files then refuse until it is set again).
  if (body.action !== 'run' && 'expectedExternalAccountId' in body) {
    // Rebinding changes which physical account's files the schedule
    // accepts: out-of-scope schedules refuse before any write.
    const bindingScoped = await requireScheduleScope(gate, id)
    if (bindingScoped) return bindingScoped
    if (typeof body.expectedExternalAccountId !== 'string' && body.expectedExternalAccountId !== null) {
      return NextResponse.json({ error: 'expectedExternalAccountId must be a string or null' }, { status: 400 })
    }
    const canonical = normalizeExternalAccountId(body.expectedExternalAccountId) ?? null
    const bound = await db.transaction(async (tx) => {
      const before = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
        select * from sftp_import_schedules where id = ${id} and org_id = ${user.orgId} for update
      `)).rows[0]
      if (!before) return null
      const after = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
        update sftp_import_schedules set expected_external_account_id = ${canonical}, updated_at = now(), updated_by = ${user.id}
         where id = ${id} and org_id = ${user.orgId}
        returning *
      `)).rows[0]
      if (!after) throw new Error('SFTP schedule binding update matched no row')
      await auditSetupChange({
        orgId: user.orgId,
        table: 'sftp_import_schedules',
        rowId: id,
        action: 'update',
        changes: { before: scheduleAuditSnapshot(before), after: scheduleAuditSnapshot(after) },
        actorId: user.id,
        requestId: requestId(req),
      }, tx)
      return after
    })
    if (!bound) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // The binding landing resolves the scheduler's named notice for this
    // schedule (same kind + href the engine writes): the inbox stays
    // truthful without the operator dismissing it by hand. Clearing the
    // binding re-arms it on the next scheduler pass. Zero matched rows is
    // the idempotent replay (already bound, already read), not a failure.
    if (canonical) {
      await db.execute(sql`
        update notifications set read_at = now(), updated_at = now()
         where org_id = ${user.orgId} and kind = ${SFTP_UNBOUND_SCHEDULE_NOTICE_KIND}
           and read_at is null and href = ${sftpUnboundScheduleNoticeHref(id)}
      `)
    }
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'run') {
    // Scoped run: activate-scan just this org's schedules and report this one.
    const owned = (await db.execute(sql`select id from sftp_import_schedules where id = ${id} and org_id = ${user.orgId}`))
    if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // A manual run imports that account's statements: an A-restricted actor
    // must never trigger (or observe) a run filing B's lines.
    const runScoped = await requireScheduleScope(gate, id)
    if (runScoped) return runScoped
    // The scan itself is engine-initiated (system-actor provenance); triggering
    // it does not turn this operator into the statements' importer.
    const runs = await runDueSftpImports(user.orgId, id)
    const mine = runs.find((r) => r.scheduleId === id)
    if (mine?.alreadyRunning) {
      return NextResponse.json(
        { error: mine.errors[0], code: 'SFTP_IMPORT_ALREADY_RUNNING' },
        { status: 409 },
      )
    }
    if (mine) return NextResponse.json({ ok: true, result: mine })
    // No scan executed for this schedule: the engine deliberately excludes
    // inactive schedules, inactive servers, non-production orgs, and orgs
    // with bank feeds off. Answering zero counts here would be
    // indistinguishable from a genuine clean scan of an empty folder, so
    // refuse by name with the real remedy instead of claiming success. The
    // diagnosis runs AFTER the scan, so a schedule deactivated (or deleted)
    // between the ownership check and the scan still refuses truthfully;
    // nothing here enables a schedule or server.
    return await refuseUnexecutedRun(id, user.orgId)
  }
  // Toggling (de)activates imports for the bound account, so it gates like
  // the run branch. The zero-row check below still owns the missing case for
  // unrestricted callers.
  const toggleScoped = await requireScheduleScope(gate, id)
  if (toggleScoped) return toggleScoped
  // A zero-row toggle is a failure, not a success: without the affected-row
  // check a missing or foreign-tenant id would report {ok:true} while no read
  // can observe any effect. Refuse exactly like the run branch above.
  const updated = await db.transaction(async (tx) => {
    const before = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
      select * from sftp_import_schedules where id = ${id} and org_id = ${user.orgId} for update
    `)).rows[0]
    if (!before) return null
    const after = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
      update sftp_import_schedules set is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${user.id}
       where id = ${id} and org_id = ${user.orgId}
      returning *
    `)).rows[0]
    if (!after) throw new Error('SFTP schedule toggle matched no row')
    await auditSetupChange({
      orgId: user.orgId,
      table: 'sftp_import_schedules',
      rowId: id,
      action: 'update',
      changes: { before: scheduleAuditSnapshot(before), after: scheduleAuditSnapshot(after) },
      actorId: user.id,
      requestId: requestId(req),
    }, tx)
    return after
  })
  if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const deleteScoped = await requireScheduleScope(gate, id)
  if (deleteScoped) return deleteScoped
  // Same zero-row rule as the toggle above: a delete that matches nothing
  // (missing or foreign-tenant id) refuses with 'not found' rather than
  // reporting {ok:true}. The org-scoped predicate keeps foreign ids
  // indistinguishable from absent.
  const deleted = await db.transaction(async (tx) => {
    const before = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
      select * from sftp_import_schedules where id = ${id} and org_id = ${user.orgId} for update
    `)).rows[0]
    if (!before) return null
    const removed = (await tx.execute<{ id: string }>(sql`
      delete from sftp_import_schedules where id = ${id} and org_id = ${user.orgId}
      returning id
    `)).rows[0]
    if (!removed) throw new Error('SFTP schedule delete matched no row')
    await auditSetupChange({
      orgId: user.orgId,
      table: 'sftp_import_schedules',
      rowId: id,
      action: 'delete',
      changes: { before: scheduleAuditSnapshot(before) },
      actorId: user.id,
      requestId: requestId(req),
    }, tx)
    return removed
  })
  if (!deleted) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // A deleted schedule has no setting to visit: resolve its named notice so
  // a stale item cannot outlive the schedule it names.
  await db.execute(sql`
    update notifications set read_at = now(), updated_at = now()
     where org_id = ${user.orgId} and kind = ${SFTP_UNBOUND_SCHEDULE_NOTICE_KIND}
       and read_at is null and href = ${sftpUnboundScheduleNoticeHref(id)}
  `)
  return NextResponse.json({ ok: true })
}
