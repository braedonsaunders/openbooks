import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { runDueSftpImports, sftpImportScheduleRunLockKey } from '@openbooks/engine/src/sftp/import-job.ts'
import { SFTP_UNBOUND_SCHEDULE_NOTICE_KIND, sftpUnboundScheduleNoticeHref } from '@openbooks/engine/src/sftp/schedule-notice.ts'
import { findSftpWatchFolderOverlap, normalizeSftpWatchFolder, sftpWatchFolderOverlapRefusal } from '@openbooks/engine/src/sftp/watch-folders.ts'
import { normalizeExternalAccountId } from '@openbooks/engine/src/banking/banking.ts'
import { auditSetupChange } from '../../../../../../lib/setup/audit'
import { randomUUID } from 'node:crypto'
import { isUuid } from '../../../../../../lib/list-params'
import { guardSubsidiaryScope, type Authz } from '../../../../../../lib/authz'
import { lockScheduleAccount } from '../_lib'
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z.object({ "action": z.string().optional(), "isActive": z.boolean().optional(), "expectedExternalAccountId": z.unknown().optional() }).passthrough();



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
    account_id: string | null
    account_number: string | null
    account_name: string | null
    account_active: boolean | null
    account_reconcilable: boolean | null
    account_summary: boolean | null
  }>(sql`
    select sc.is_active as schedule_active,
           sv.id as server_id,
           sv.is_active as server_active,
           o.env_kind,
           -- Registry fallback shape (non-boolean stored values fall back to
           -- the default instead of throwing 22P02).
           case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end as feeds_on,
           a.id as account_id,
           a.number as account_number,
           a.name as account_name,
           a.is_active as account_active,
           a.reconcilable as account_reconcilable,
           a.is_summary as account_summary
      from sftp_import_schedules sc
      left join sftp_servers sv on sv.id = sc.sftp_server_id and sv.org_id = sc.org_id
      join orgs o on o.id = sc.org_id
      left join accounts a on a.id = sc.account_id and a.org_id = sc.org_id
     where sc.id = ${scheduleId} and sc.org_id = ${orgId}
  `))
  const row = diagnosis.rows[0]
  // Deleted between the ownership check and the scan: same answer as never
  // owned, never a fabricated result.
  if (!row) return notFound("record")
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
  // The engine refuses the tick when the bound account is gone or ineligible,
  // but that refusal arrives as a no-result scan — without this branch the
  // diagnosis above passes everything and the operator gets the stale-race
  // message for an account that will never import, no matter how often the
  // run is retried.
  if (!row.account_id) {
    return NextResponse.json(
      { error: 'The bank account for this schedule no longer exists — rebind the schedule to a live reconcilable account in Company Settings → Bank Feeds before running.', code: 'SCHEDULE_ACCOUNT_MISSING' },
      { status: 409 },
    )
  }
  if (!row.account_active || !row.account_reconcilable || row.account_summary) {
    const label = [row.account_number, row.account_name].filter((part) => part !== null && part !== '').join(' · ') || 'the bound bank account'
    return NextResponse.json(
      { error: `The bank account ${label} bound to this schedule is not eligible for import (it must be active, reconcilable, and non-summary) — rebind the schedule to a live reconcilable account in Company Settings → Bank Feeds before running.`, code: 'SCHEDULE_ACCOUNT_INELIGIBLE' },
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
export const PATCH = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'bankFeeds',
  body: PATCHBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const body = (routeBody) as { action?: string; isActive?: boolean; expectedExternalAccountId?: unknown }
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
          const route = (await tx.execute<{ sftp_server_id: string }>(sql`
            select sftp_server_id from sftp_import_schedules where id = ${id} and org_id = ${user.orgId}
          `)).rows[0]
          if (!route) return null
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sftp-schedule-folders:${user.orgId}:${route.sftp_server_id}`}, 0))`)
          const runLock = (await tx.execute<{ acquired: boolean }>(sql`
            select pg_try_advisory_xact_lock(hashtextextended(${sftpImportScheduleRunLockKey(user.orgId, id)}, 0)) as acquired
          `)).rows[0]?.acquired
          if (!runLock) return { busy: true as const }
          const before = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
            select * from sftp_import_schedules where id = ${id} and org_id = ${user.orgId} for update
          `)).rows[0]
          if (!before) return null
          const account = (await tx.execute<{ subsidiary_id: string | null }>(sql`
            select subsidiary_id from accounts
             where id = ${before.account_id} and org_id = ${user.orgId}
             for share
          `)).rows[0]
          if (!account || guardSubsidiaryScope(gate, account.subsidiary_id)) return { scope: true as const }
          if (before.run_claim_token) return { busy: true as const }
          // Rebinding changes which physical account's files the schedule
          // accepts: recheck the bound account's subsidiary under the account
          // row lock (the lock the account rehome writer holds), so a rehome
          // racing this write cannot move the account out from under the
          // pre-transaction scope check above.
          const boundAccount = await lockScheduleAccount(tx, user.orgId, String(before.account_id))
          const boundScopeDenied = guardSubsidiaryScope(gate, boundAccount?.subsidiary_id ?? null)
          if (boundScopeDenied) return boundScopeDenied
          const after = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
            update sftp_import_schedules set expected_external_account_id = ${canonical}, updated_at = now(), updated_by = ${user.id}
             where id = ${id} and org_id = ${user.orgId} and run_claim_token is null
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
        if (!bound) return notFound("record")
        if ('scope' in bound) return notFound("record")
        if ('busy' in bound) {
          return NextResponse.json(
            { error: 'This schedule is being scanned; wait for the scan to finish before changing its expected bank account.' },
            { status: 409 },
          )
        }
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
        if (!owned.rows[0]) return notFound("record")
        // A manual run imports that account's statements: an A-restricted actor
        // must never trigger (or observe) a run filing B's lines.
        const runScoped = await requireScheduleScope(gate, id)
        if (runScoped) return runScoped
        // Recheck the bound account's subsidiary under the account row lock
        // immediately before triggering the scan, so a rehome racing the
        // trigger cannot move the account out from under the check above.
        const runScopeDenied = await db.transaction(async (tx) => {
          const target = (await tx.execute<{ account_id: string }>(sql`
            select account_id from sftp_import_schedules
             where id = ${id} and org_id = ${user.orgId}
             for update
          `)).rows[0]
          if (!target) return null
          const runAccount = await lockScheduleAccount(tx, user.orgId, target.account_id)
          return guardSubsidiaryScope(gate, runAccount?.subsidiary_id ?? null)
        })
        if (runScopeDenied) return runScopeDenied
        // The scan itself is engine-initiated (system-actor provenance); triggering
        // it does not turn this operator into the statements' importer.
        const runs = await runDueSftpImports(user.orgId, id, {
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : null,
        })
        const mine = runs.find((r) => r.scheduleId === id)
        if (mine?.alreadyRunning) {
          return NextResponse.json(
            { error: mine.errors[0], code: 'SFTP_IMPORT_ALREADY_RUNNING' },
            { status: 409 },
          )
        }
        if (mine?.notRun === 'account-scope') return notFound("record")
        if (mine?.notRun === 'inactive') return await refuseUnexecutedRun(id, user.orgId)
        if (mine?.notRun === 'configuration-conflict') {
          return NextResponse.json({ error: mine.errors[0] ?? 'SFTP schedule configuration prevents this run.' }, { status: 409 })
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
    const toggleScoped = await requireScheduleScope(gate, id)
    if (toggleScoped) return toggleScoped
    const updated = await db.transaction(async (tx) => {
        const route = (await tx.execute<{ sftp_server_id: string }>(sql`
          select sftp_server_id from sftp_import_schedules where id = ${id} and org_id = ${user.orgId}
        `)).rows[0]
        if (!route) return null
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'sftp-schedule-folders:' + user.orgId + ':' + route.sftp_server_id}, 0))`)
        const runLock = (await tx.execute<{ acquired: boolean }>(sql`
          select pg_try_advisory_xact_lock(hashtextextended(${sftpImportScheduleRunLockKey(user.orgId, id)}, 0)) as acquired
        `)).rows[0]?.acquired
        if (!runLock) return { busy: true as const }
        const before = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
          select * from sftp_import_schedules where id = ${id} and org_id = ${user.orgId} for update
        `)).rows[0]
        if (!before) return null
        const account = (await tx.execute<{ subsidiary_id: string | null }>(sql`
          select subsidiary_id from accounts
           where id = ${before.account_id} and org_id = ${user.orgId}
           for share
        `)).rows[0]
        if (!account || guardSubsidiaryScope(gate, account.subsidiary_id)) return { scope: true as const }
        // The schedule lock proves no scan still owns this claim. A token left by
        // a worker that died is therefore stale and can be invalidated safely.
        if (before.run_claim_token) {
          await tx.execute(sql`
            update sftp_import_schedules
               set run_claim_token = null, run_claimed_at = null
             where id = ${id} and org_id = ${user.orgId}
          `)
        }
        const activate = body.isActive !== false
        if (activate && before.is_active === false) {
          const siblings = (await tx.execute<{ id: string; folder: string; account_label: string }>(sql`
            select sc.id, sc.folder,
                   coalesce(nullif(a.number, ''), a.name, sc.account_id::text) as account_label
              from sftp_import_schedules sc
              join accounts a on a.id = sc.account_id and a.org_id = sc.org_id
             where sc.org_id = ${user.orgId} and sc.sftp_server_id = ${before.sftp_server_id}
               and sc.is_active and sc.id <> ${id}
             for update of sc
          `)).rows
          const siblingRefs = siblings.map((row) => ({
            id: row.id,
            folder: row.folder,
            accountLabel: row.account_label,
          }))
          let overlap: ReturnType<typeof findSftpWatchFolderOverlap>
          try {
            overlap = findSftpWatchFolderOverlap(String(before.folder), siblingRefs)
          } catch {
            const invalid = siblings.find((row) => {
              try {
                normalizeSftpWatchFolder(row.folder)
                return false
              } catch {
                return true
              }
            })
            return { conflict: `SFTP schedule '${invalid?.id ?? ''}' has invalid folder '${invalid?.folder ?? ''}'; deactivate or delete it before activating another route` }
          }
          if (overlap) {
            return { conflict: sftpWatchFolderOverlapRefusal(String(before.folder), overlap) }
          }
        }
        const after = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
          update sftp_import_schedules set is_active = ${activate}, updated_at = now(), updated_by = ${user.id}
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
    if (!updated) return notFound("record")
    if ('scope' in updated) return notFound("record")
    if ('busy' in updated) {
        return NextResponse.json(
          { error: 'This schedule is being scanned; wait for the scan to finish before changing its active state.' },
          { status: 409 },
        )
      }
    if ('conflict' in updated) return NextResponse.json({ error: updated.conflict }, { status: 409 })
    return NextResponse.json({ ok: true })
  },
});

export const DELETE = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'bankFeeds',
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const deleteScoped = await requireScheduleScope(gate, id)
    if (deleteScoped) return deleteScoped
    const deleted = await db.transaction(async (tx) => {
        const route = (await tx.execute<{ sftp_server_id: string }>(sql`
          select sftp_server_id from sftp_import_schedules where id = ${id} and org_id = ${user.orgId}
        `)).rows[0]
        if (!route) return null
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'sftp-schedule-folders:' + user.orgId + ':' + route.sftp_server_id}, 0))`)
        const runLock = (await tx.execute<{ acquired: boolean }>(sql`
          select pg_try_advisory_xact_lock(hashtextextended(${sftpImportScheduleRunLockKey(user.orgId, id)}, 0)) as acquired
        `)).rows[0]?.acquired
        if (!runLock) return { busy: true as const }
        const before = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
          select * from sftp_import_schedules where id = ${id} and org_id = ${user.orgId} for update
        `)).rows[0]
        if (!before) return null
        const account = (await tx.execute<{ subsidiary_id: string | null }>(sql`
          select subsidiary_id from accounts
           where id = ${before.account_id} and org_id = ${user.orgId}
           for share
        `)).rows[0]
        if (!account || guardSubsidiaryScope(gate, account.subsidiary_id)) return { scope: true as const }
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
    if (!deleted) return notFound("record")
    if ('scope' in deleted) return notFound("record")
    if ('busy' in deleted) {
        return NextResponse.json(
          { error: 'This schedule is being scanned; wait for the scan to finish before deleting it.' },
          { status: 409 },
        )
      }
    await db.execute(sql`
        update notifications set read_at = now(), updated_at = now()
         where org_id = ${user.orgId} and kind = ${SFTP_UNBOUND_SCHEDULE_NOTICE_KIND}
           and read_at is null and href = ${sftpUnboundScheduleNoticeHref(id)}
      `)
    return NextResponse.json({ ok: true })
  },
});
