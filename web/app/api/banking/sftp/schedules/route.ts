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

export const runtime = 'nodejs'
const FORMATS = new Set(['auto', 'ofx', 'csv', 'camt053', 'bai2', 'mt940'])

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
  const folder = (String(body.folder ?? 'inbound').trim() || 'inbound').replace(/^\/+|\/+$/g, '')
  // The one external account identifier this schedule accepts. Stored
  // canonical (whitespace-blind, case-blind) so the import comparison
  // cannot be smuggled past spacing or case; absent stays null (an
  // identified file then refuses until the schedule names its account).
  const expectedExternalAccountId = normalizeExternalAccountId(expectedExternalAccountInput)
  try {
    const r = (await db.execute<{ id: string }>(sql`
      insert into sftp_import_schedules (org_id, sftp_server_id, account_id, format, folder, csv_mapping, expected_external_account_id, created_by)
      values (${user.orgId}, ${body.sftpServerId}, ${body.accountId}, ${format}, ${folder},
              ${body.csvMapping ? JSON.stringify(body.csvMapping) : null}::jsonb, ${expectedExternalAccountId ?? null}, ${user.id})
      returning id
    `))
    return NextResponse.json({ id: r.rows[0]!.id })
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
