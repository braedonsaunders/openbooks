import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { defineRoute } from '@/lib/api/route'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { ensurePartyRoleRow } from '../../../../../lib/party-roles'
import { BULK_ACTION_MAX_IDS } from '../../../../../lib/api/bulk-ids'

export const runtime = 'nodejs'

const assignBody = z.object({
  role: z.enum(['customer', 'vendor', 'employee']),
  /** Same free-text filter as the party directory (?q=). */
  q: z.string().trim().max(200).optional(),
  /** Mirror the directory's show-inactives toggle; active parties only by default. */
  includeInactive: z.boolean().optional(),
}).strict()

/**
 * Bulk-assign one native role to every role-less party in the directory
 * slice the caller names. The slice is the directory's own filter — the
 * search text and the show-inactives toggle — re-applied server-side under
 * the caller's subsidiary fence, so a restricted caller can only promote
 * parties its lists already show.
 *
 * Each party is promoted independently through the native role command
 * (insert-only: an existing role row, active or deactivated, is never
 * flipped), audited with its before/after state. The request refuses above
 * the shared bulk ceiling instead of truncating — narrow the directory
 * search and repeat. Re-running is safe: promoting an already-promoted
 * party is a no-op that still reports it.
 *
 * POST { role, q?, includeInactive? } → { assigned, total }
 */
export const POST = defineRoute({
  permission: 'parties.manage',
  feature: { none: 'Parties are shared master records; CRM capabilities do not gate their roles.' },
  body: assignBody,
  invalidBodyStatus: 422,
  handler: async ({ body, authz }) => {
    const orgId = authz.user.orgId
    const role = body.role
    const q = body.q?.trim() ? `%${body.q.trim()}%` : null

    const candidates = (await db.execute(sql`
      select p.id, p.is_active from parties p
       where p.org_id = ${orgId}
        ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
        ${q ? sql` and (p.display_name ilike ${q} or p.short_code ilike ${q} or p.email ilike ${q})` : sql``}
        ${body.includeInactive ? sql`` : sql` and p.is_active`}
        and not exists (select 1 from customer_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)
        and not exists (select 1 from vendor_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)
        and not exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)
       order by p.display_name
       limit ${BULK_ACTION_MAX_IDS + 1}`)) as { rows: { id: string; is_active: boolean }[] }

    if (candidates.rows.length > BULK_ACTION_MAX_IDS) {
      return NextResponse.json({
        error: `More than ${BULK_ACTION_MAX_IDS} role-less parties match — narrow the directory search and assign in batches of ${BULK_ACTION_MAX_IDS}.`,
      }, { status: 422 })
    }

    let assigned = 0
    for (const party of candidates.rows) {
      await db.transaction(async (tx) => {
        const before = (await tx.execute(sql`
          select kind, is_active from parties where id = ${party.id} and org_id = ${orgId}`)) as {
          rows: { kind: string; is_active: boolean }[]
        }
        if (!before.rows[0]) throw new Error(`party ${party.id} not found in this organization`)
        await ensurePartyRoleRow(tx, {
          orgId,
          partyId: party.id,
          kind: role,
          isActive: before.rows[0].is_active,
          actorId: authz.user.id,
        })
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'parties', ${party.id}, 'update',
                  ${JSON.stringify({ source: 'bulk-role-assign', role, before: before.rows[0], after: { ...before.rows[0], [role]: true } })}::jsonb, ${authz.user.id})`)
      })
      assigned++
    }

    return NextResponse.json({ assigned, total: candidates.rows.length })
  },
})
