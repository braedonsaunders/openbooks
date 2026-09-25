import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { pgErrorCode } from '../../../../../lib/setup/coerce'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { normalizeExternalAccountId } from '@openbooks/engine/src/banking/banking.ts'
import { auditSetupChange } from '../../../../../lib/setup/audit'
import { randomUUID } from 'node:crypto'
import { findSftpWatchFolderOverlap, normalizeSftpWatchFolder, sftpWatchFolderOverlapRefusal } from '@openbooks/engine/src/sftp/watch-folders.ts'

export const runtime = 'nodejs'
const FORMATS = new Set(['auto', 'ofx', 'csv', 'camt053', 'bai2', 'mt940'])
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

/** List import schedules (with server + account names) for the org. */
export async function GET() {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select sc.id, sc.sftp_server_id, sc.account_id, sc.format, sc.folder, sc.is_active, sc.last_run_at, sc.last_result,
           sc.expected_external_account_id,
           sv.name as server_name, a.number as account_number, a.name as account_name
      from sftp_import_schedules sc
      join sftp_servers sv on sv.id = sc.sftp_server_id and sv.org_id = sc.org_id
      join accounts a on a.id = sc.account_id and a.org_id = sc.org_id
     where sc.org_id = ${gate.user.orgId}
       ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, gate.allowedSubsidiaryIds)}
     order by sc.created_at desc
  `))
  return NextResponse.json({ schedules: r.rows })
}

/** Create an import schedule. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { sftpServerId?: string; accountId?: string; format?: string; folder?: string; csvMapping?: unknown; expectedExternalAccountId?: unknown }
  let expectedExternalAccountInput: string | null = null
  if ('expectedExternalAccountId' in body) {
    if (typeof body.expectedExternalAccountId !== 'string' && body.expectedExternalAccountId !== null) {
      return NextResponse.json({ error: 'expectedExternalAccountId must be a string or null' }, { status: 400 })
    }
    expectedExternalAccountInput = body.expectedExternalAccountId
  }
  if (!body.sftpServerId || !isUuid(body.sftpServerId) || !body.accountId || !isUuid(body.accountId)) {
    return NextResponse.json({ error: 'sftpServerId and accountId are required' }, { status: 400 })
  }
  // Both parents are joined by (org_id, id) in GET and in the import scan,
  // so a valid-shaped id owned by another organization (or by no row at
  // all) would save with 200 yet never appear in GET and could never run.
  // Fail closed before any write, keeping foreign ids indistinguishable
  // from absent (tenant non-disclosure, like the [id] route).
  const server = (await db.execute(sql`
    select 1 from sftp_servers where id = ${body.sftpServerId} and org_id = ${user.orgId}
  `))
  if (!server.rows[0]) return NextResponse.json({ error: 'SFTP server not found' }, { status: 404 })
  // Account eligibility mirrors the engine import path: importStatement
  // refuses anything this predicate rejects (missing or foreign account, or
  // one that is not a live reconcilable account). Currency needs no
  // separate check — accounts_reconcilable_currency_required guarantees an
  // explicit currency on every reconcilable row. The message intentionally
  // matches the engine's so missing, foreign, and ineligible read alike.
  const account = (await db.execute<{ currency: string | null; subsidiary_id: string | null }>(sql`
    select currency_restriction as currency, subsidiary_id from accounts
     where id = ${body.accountId} and org_id = ${user.orgId}
       and reconcilable and is_active and not is_summary
  `))
  if (!account.rows[0]) {
    return NextResponse.json({ error: 'Account not found or not reconcilable' }, { status: 422 })
  }
  // A schedule files statements into its account: binding one to another
  // entity's account (or a shared one, for a restricted caller) is uniform
  // not-found, keeping the eligibility refusal for genuinely unusable rows.
  const scoped = guardSubsidiaryScope(gate, account.rows[0]!.subsidiary_id)
  if (scoped) return scoped
  if (!account.rows[0].currency) {
    return NextResponse.json({ error: 'Reconcilable accounts require an explicit currency before statement import or reconciliation' }, { status: 422 })
  }
  const format = FORMATS.has(String(body.format)) ? body.format : 'auto'
  let folder: string
  try {
    folder = normalizeSftpWatchFolder(String(body.folder ?? 'inbound').trim() || 'inbound')
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
  // The one external account identifier this schedule accepts. Stored
  // canonical (whitespace-blind, case-blind) so the import comparison
  // cannot be smuggled past spacing or case; absent stays null (an
  // identified file then refuses until the schedule names its account).
  const expectedExternalAccountId = normalizeExternalAccountId(expectedExternalAccountInput)
  try {
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'sftp-schedule-folders:' + user.orgId + ':' + body.sftpServerId}, 0))`)
      const eligibility = (await tx.execute<{
        server_active: boolean;
        bank_feeds_on: boolean;
        account_subsidiary_id: string | null;
        account_currency: string | null;
        account_reconcilable: boolean;
        account_active: boolean;
        account_summary: boolean;
      }>(sql`
        select sv.is_active as server_active,
               case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end as bank_feeds_on,
               a.subsidiary_id as account_subsidiary_id, a.currency_restriction as account_currency,
               a.reconcilable as account_reconcilable, a.is_active as account_active, a.is_summary as account_summary
          from sftp_servers sv join orgs o on o.id = sv.org_id
          join accounts a on a.org_id = sv.org_id and a.id = ${body.accountId}
         where sv.id = ${body.sftpServerId} and sv.org_id = ${user.orgId}
         for share of sv, o, a
      `)).rows[0]
      if (!eligibility) return { notFound: true as const }
      if (!eligibility.account_reconcilable || !eligibility.account_active || eligibility.account_summary) {
        return { ineligible: true as const }
      }
      if (!eligibility.server_active || !eligibility.bank_feeds_on) {
        return { conflict: 'SFTP server or bank feeds changed while the schedule was being created; enable bank feeds before retrying' }
      }
      const txScope = guardSubsidiaryScope(gate, eligibility.account_subsidiary_id)
      if (txScope) return { conflict: 'Account is outside the caller’s subsidiary scope' }
      if (!eligibility.account_currency) {
        return { conflict: 'Reconcilable accounts require an explicit currency before statement import or reconciliation' }
      }
      const siblings = (await tx.execute<{ id: string; folder: string; account_label: string }>(sql`
        select sc.id, sc.folder,
               coalesce(nullif(a.number, ''), a.name, sc.account_id::text) as account_label
          from sftp_import_schedules sc
          join accounts a on a.id = sc.account_id and a.org_id = sc.org_id
         where sc.org_id = ${user.orgId} and sc.sftp_server_id = ${body.sftpServerId}
           and sc.is_active
         for update of sc
      `)).rows
      const siblingRefs = siblings.map((row) => ({
        id: row.id,
        folder: row.folder,
        accountLabel: row.account_label,
      }))
      let overlap: ReturnType<typeof findSftpWatchFolderOverlap>
      try {
        overlap = findSftpWatchFolderOverlap(folder, siblingRefs)
      } catch {
        const invalid = siblings.find((row) => {
          try {
            normalizeSftpWatchFolder(row.folder)
            return false
          } catch {
            return true
          }
        })
        return {
          conflict: `SFTP schedule '${invalid?.id ?? ''}' has invalid folder '${invalid?.folder ?? ''}'; deactivate or delete it before creating another route`,
        }
      }
      if (overlap) {
        return { conflict: sftpWatchFolderOverlapRefusal(folder, overlap) }
      }
      const inserted = (await tx.execute<{ id: string } & Record<string, unknown>>(sql`
      insert into sftp_import_schedules (org_id, sftp_server_id, account_id, format, folder, csv_mapping, expected_external_account_id, created_by)
      values (${user.orgId}, ${body.sftpServerId}, ${body.accountId}, ${format}, ${folder},
              ${body.csvMapping ? JSON.stringify(body.csvMapping) : null}::jsonb, ${expectedExternalAccountId ?? null}, ${user.id})
      returning id, sftp_server_id, account_id, format, folder, csv_mapping, expected_external_account_id,
                is_active, created_by, updated_by
    `)).rows[0]
      if (!inserted) throw new Error('SFTP schedule insert returned no row')
      await auditSetupChange({
        orgId: user.orgId,
        table: 'sftp_import_schedules',
        rowId: inserted.id,
        action: 'insert',
        changes: { after: scheduleAuditSnapshot(inserted) },
        actorId: user.id,
        requestId: requestId(req),
      }, tx)
      return { inserted }
    })
    if ('notFound' in r) return NextResponse.json({ error: 'SFTP server or account not found' }, { status: 404 })
    if ('ineligible' in r) return NextResponse.json({ error: 'Account not found or not reconcilable' }, { status: 422 })
    if ('conflict' in r) {
      const status = r.conflict === 'Account is outside the caller’s subsidiary scope' ? 404 : 409
      return NextResponse.json({ error: r.conflict }, { status })
    }
    return NextResponse.json({ id: r.inserted.id })
  } catch (e) {
    // A parent deleted between the checks above and the insert still refuses
    // at the storage layer (0242 composite FKs) — surface the same typed
    // refusal the checks return instead of a raw 500.
    if (pgErrorCode(e) === '23503') {
      const constraint = String(
        (e as { constraint?: unknown }).constraint
          ?? (e as { cause?: { constraint?: unknown } }).cause?.constraint
          ?? '',
      )
      if (constraint.includes('sftp_server')) {
        return NextResponse.json({ error: 'SFTP server not found' }, { status: 404 })
      }
      return NextResponse.json({ error: 'Account not found or not reconcilable' }, { status: 422 })
    }
    throw e
  }
}
