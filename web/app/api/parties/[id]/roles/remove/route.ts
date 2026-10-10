import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { AR_KINDS, AP_KINDS } from '@openbooks/engine/src/records/document-kinds.ts'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { guardSubsidiaryScope } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

const ROLE_TABLES = {
  customer: 'customer_roles',
  vendor: 'vendor_roles',
  employee: 'employee_roles',
} as const

type PartyRole = keyof typeof ROLE_TABLES

/** Stored kind once its naming role is gone: customers and vendors fall back to a company, employees to a person. */
const ROLE_BASE_KINDS: Record<PartyRole, 'company' | 'person'> = {
  customer: 'company',
  vendor: 'company',
  employee: 'person',
}

const removeBody = z.object({ role: z.enum(['customer', 'vendor', 'employee']) }).strict()

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

/**
 * Remove one native role from a party. Deleting the row is permanent, so a
 * role with open activity refuses by name: the refusal counts the blocking
 * records and names the supported remedy (deactivate the role instead, which
 * keeps the history readable). A clean role deletes with its kind fallback —
 * a stored role-kind without its role row is a claim no read can back, so
 * the kind returns to its base alongside the deletion — and the whole change
 * is audited with before/after state.
 *
 * POST /api/parties/{id}/roles/remove { role } → { removed: true, kind }
 */
export const POST = defineRoute({
  permission: 'parties.manage',
  feature: { none: 'Parties are shared master records; CRM capabilities do not gate their roles.' },
  params: z.object({ id: z.string() }),
  body: removeBody,
  invalidBodyStatus: 422,
  handler: async ({ body, authz, params }) => {
    const orgId = authz.user.orgId
    if (!isUuid(params.id)) return notFound('record')
    const role = body.role as PartyRole
    const table = ROLE_TABLES[role]

    const party = (await db.execute<{
      id: string
      kind: string
      display_name: string
      subsidiary_id: string | null
      is_active: boolean
    }>(sql`
      select id, kind, display_name, subsidiary_id, is_active from parties
       where id = ${params.id} and org_id = ${orgId} limit 1`)).rows[0]
    if (!party) return notFound('record')
    const scoped = guardSubsidiaryScope(authz, party.subsidiary_id, { orgWideNull: true })
    if (scoped) return scoped

    const roleRow = (await db.execute<Record<string, unknown>>(sql`
      select * from ${sql.raw(table)} where org_id = ${orgId} and party_id = ${party.id} limit 1`)).rows[0]
    if (!roleRow) return bad(`This party has no ${role} role to remove.`)

    // Open activity is transactional evidence, checked per role: live
    // documents and their open balances for commercial roles (the same live
    // predicate party deactivation uses), open pipeline for customers,
    // unapproved time for employees.
    const activity = await openRoleActivity(orgId, party.id, role)
    if (activity.length > 0) {
      return bad(
        `Cannot remove the ${role} role — ${activity.join('; ')}. ` +
        `Deactivate the ${role} role instead to keep the history.`,
      )
    }

    const nextKind = party.kind === role ? ROLE_BASE_KINDS[role] : party.kind
    const removed = await db.transaction(async (tx) => {
      // A required write matching zero rows is a failure: the role row is
      // re-checked inside the write transaction, so a concurrent removal or
      // deactivation race fails closed instead of auditing a removal that
      // never happened.
      const deleted = (await tx.execute<{ id: string }>(sql`
        delete from ${sql.raw(table)} where org_id = ${orgId} and party_id = ${party.id} returning id`)).rows[0]
      if (!deleted) throw new Error(`the ${role} role changed while removing it — reload and try again`)
      if (nextKind !== party.kind) {
        const renamed = (await tx.execute<{ id: string }>(sql`
          update parties set kind = ${nextKind}, updated_at = now(), updated_by = ${authz.user.id}
           where id = ${party.id} and org_id = ${orgId} returning id`)).rows[0]
        if (!renamed) throw new Error('the party changed while removing its role — reload and try again')
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'parties', ${party.id}, 'update',
                ${JSON.stringify({
                  source: 'role-remove',
                  role,
                  before: { kind: party.kind, role: roleRow },
                  after: { kind: nextKind, role: null },
                })}::jsonb, ${authz.user.id})`)
      return nextKind
    })

    return NextResponse.json({ removed: true, kind: removed })
  },
})

/** Human-counted blockers per role; empty means the role removes cleanly. */
async function openRoleActivity(orgId: string, partyId: string, role: PartyRole): Promise<string[]> {
  if (role === 'employee') {
    const weeks = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from timesheet_weeks
       where org_id = ${orgId} and employee_party_id = ${partyId} and status in ('draft', 'submitted')`)).rows[0]
    const count = Number(weeks?.n ?? '0')
    return count > 0 ? [`${count} unapproved timesheet ${count === 1 ? 'week remains' : 'weeks remain'}`] : []
  }
  const kinds = role === 'customer' ? [...AR_KINDS] : [...AP_KINDS]
  const kindList = sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)
  const docs = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from documents
     where org_id = ${orgId} and party_id = ${partyId} and kind in (${kindList})
       and (status in ('pending_approval', 'approved') or (status = 'posted' and coalesce(open_balance, 0) <> 0))`)).rows[0]
  const blockers: string[] = []
  const docCount = Number(docs?.n ?? '0')
  if (docCount > 0) {
    const noun = role === 'customer'
      ? docCount === 1 ? 'open invoice with an open balance remains' : 'open invoices with open balances remain'
      : docCount === 1 ? 'open bill with an open balance remains' : 'open bills with open balances remain'
    blockers.push(`${docCount} ${noun}`)
  }
  if (role === 'customer') {
    const pipeline = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from crm_opportunities o
        join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
       where o.org_id = ${orgId} and o.party_id = ${partyId} and o.is_active and not s.is_closed`)).rows[0]
    const pipeCount = Number(pipeline?.n ?? '0')
    if (pipeCount > 0) {
      blockers.push(`${pipeCount} open ${pipeCount === 1 ? 'opportunity remains' : 'opportunities remain'}`)
    }
  }
  return blockers
}
