import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardUnrestrictedScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { validateCriteria, validateOutcome } from '../../../../lib/banking-rules-validate'

export const runtime = 'nodejs'

function build(body: Record<string, unknown>): { error: string } | { criteria: unknown; outcome: unknown } {
  const c = validateCriteria(body.criteria)
  if (!c.ok) return { error: c.error }
  const o = validateOutcome(body.outcome)
  if (!o.ok) return { error: o.error }
  return { criteria: c.value, outcome: o.value }
}

/** Priority funnel: the column is integer, and neither verb catches the
 *  write — a value the column cannot hold would escape as a raw 500. */
function priority(body: Record<string, unknown>): { error: string } | { priority: number } {
  const raw = body.priority
  if (raw === undefined || raw === null || raw === '') return { priority: 100 }
  const n = Number(raw)
  if (!Number.isInteger(n) || n > 2147483647 || n < -2147483648) {
    return { error: 'priority must be a whole number the rule list can store' }
  }
  return { priority: n }
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  // Bank rules are org-wide automation: one rule can exclude or categorize
  // any account's lines, so only unrestricted callers may define them
  // (canonical org-wide-policy shape: 403 naming the remedy).
  const unrestricted = guardUnrestrictedScope(gate)
  if (unrestricted) return unrestricted
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  if (!body.name || String(body.name).trim() === '' || String(body.name).length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const built = build(body)
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  const prio = priority(body)
  if ('error' in prio) return NextResponse.json({ error: prio.error }, { status: 400 })
  // Match rules decide how imported bank lines are categorized and posted, so
  // every write lands in the audit trail inside the same transaction.
  const created = await db.transaction(async (tx) => {
    const row = (await tx.execute<Record<string, unknown>>(sql`
      insert into bank_match_rules (org_id, name, criteria, outcome, priority, is_active, created_by)
      values (${user.orgId}, ${String(body.name).trim()}, ${JSON.stringify(built.criteria)}::jsonb,
              ${JSON.stringify(built.outcome)}::jsonb, ${prio.priority}, ${body.isActive !== false}, ${user.id})
      returning *
    `))
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${user.orgId}, 'bank_match_rules', ${String(row.rows[0]!.id)}, 'insert',
         ${JSON.stringify({ after: row.rows[0] })}::jsonb, ${user.id})
    `)
    return row.rows[0]!
  })
  return NextResponse.json({ id: ((created)).id as string })
}

export async function PATCH(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  // Same org-wide-automation rule as POST: editing a rule can redirect any
  // account's auto-categorization (canonical org-wide-policy 403).
  const unrestricted = guardUnrestrictedScope(gate)
  if (unrestricted) return unrestricted
  const { user } = gate
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as Record<string, unknown>
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  // A malformed id would surface as a Postgres uuid throw and a raw 500;
  // resolve it through the same 404 as an unknown rule.
  if (typeof body.id !== 'string' || !isUuid(body.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!body.name || String(body.name).trim() === '' || String(body.name).length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const built = build(body)
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  const prio = priority(body)
  if ('error' in prio) return NextResponse.json({ error: prio.error }, { status: 400 })
  const missing = await db.transaction(async (tx) => {
    // Serialize rule edits from the row snapshot that supplies the audit
    // before-image. A concurrent PATCH waits here, then PostgreSQL's
    // READ COMMITTED snapshot is refreshed to the winner's committed row
    // before this transaction updates and audits it.
    const before = (await tx.execute<Record<string, unknown>>(sql`
      select * from bank_match_rules where id = ${body.id} and org_id = ${user.orgId}
       for update
    `))
    if (!before.rows[0]) return true
    const updated = (await tx.execute<Record<string, unknown>>(sql`
      update bank_match_rules set
        name = ${String(body.name).trim()}, criteria = ${JSON.stringify(built.criteria)}::jsonb,
        outcome = ${JSON.stringify(built.outcome)}::jsonb, priority = ${prio.priority},
        is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${user.id}
      where id = ${body.id} and org_id = ${user.orgId}
      returning *
    `))
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${user.orgId}, 'bank_match_rules', ${String(body.id)}, 'update',
         ${JSON.stringify({ before: before.rows[0], after: updated.rows[0] })}::jsonb, ${user.id})
    `)
    return false
  })
  if (missing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
