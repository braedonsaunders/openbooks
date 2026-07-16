import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import type { RuleCriteria, RuleOutcome } from '../../../../lib/banking-rules'

export const runtime = 'nodejs'

const SIGNS = new Set(['in', 'out', 'any'])

function sanitize(body: Record<string, unknown>): { error: string } | { criteria: RuleCriteria; outcome: RuleOutcome } {
  const rawC = (body.criteria ?? {}) as Record<string, unknown>
  const criteria: RuleCriteria = {}
  if (rawC.descriptionContains) criteria.descriptionContains = String(rawC.descriptionContains).slice(0, 200)
  if (rawC.amountSign && SIGNS.has(String(rawC.amountSign)) && rawC.amountSign !== 'any') {
    criteria.amountSign = rawC.amountSign as 'in' | 'out'
  }
  if (rawC.minAmount !== undefined && rawC.minAmount !== null && rawC.minAmount !== '') {
    const n = Number(rawC.minAmount)
    if (!Number.isFinite(n) || n < 0) return { error: 'min amount must be a non-negative number' }
    criteria.minAmount = n
  }
  if (rawC.maxAmount !== undefined && rawC.maxAmount !== null && rawC.maxAmount !== '') {
    const n = Number(rawC.maxAmount)
    if (!Number.isFinite(n) || n < 0) return { error: 'max amount must be a non-negative number' }
    criteria.maxAmount = n
  }
  if (typeof criteria.minAmount === 'number' && typeof criteria.maxAmount === 'number' && criteria.minAmount > criteria.maxAmount) {
    return { error: 'min amount cannot exceed max amount' }
  }
  if (rawC.source) criteria.source = String(rawC.source).slice(0, 40)

  const rawO = (body.outcome ?? {}) as Record<string, unknown>
  let outcome: RuleOutcome
  if (rawO.action === 'exclude') {
    outcome = { action: 'exclude' }
  } else if (rawO.action === 'categorize') {
    if (!rawO.accountId || typeof rawO.accountId !== 'string') {
      return { error: 'categorize rules require an offset account' }
    }
    outcome = { action: 'categorize', accountId: rawO.accountId, partyId: (rawO.partyId as string) || null }
  } else {
    return { error: 'outcome action must be "exclude" or "categorize"' }
  }
  return { criteria, outcome }
}

export async function POST(req: Request) {
  const gate = await guardPermission('banking.reconcile')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json()) as Record<string, unknown>
  if (!body.name || String(body.name).trim() === '' || String(body.name).length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const s = sanitize(body)
  if ('error' in s) return NextResponse.json({ error: s.error }, { status: 400 })
  const r = (await db.execute(sql`
    insert into bank_match_rules (org_id, name, criteria, outcome, priority, is_active, created_by)
    values (${user.orgId}, ${String(body.name).trim()}, ${JSON.stringify(s.criteria)}::jsonb,
            ${JSON.stringify(s.outcome)}::jsonb, ${Number(body.priority) || 100}, ${body.isActive !== false}, ${user.id})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return NextResponse.json({ id: r.rows[0]!.id })
}

export async function PATCH(req: Request) {
  const gate = await guardPermission('banking.reconcile')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json()) as Record<string, unknown>
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (!body.name || String(body.name).trim() === '' || String(body.name).length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const s = sanitize(body)
  if ('error' in s) return NextResponse.json({ error: s.error }, { status: 400 })
  await db.execute(sql`
    update bank_match_rules set
      name = ${String(body.name).trim()}, criteria = ${JSON.stringify(s.criteria)}::jsonb,
      outcome = ${JSON.stringify(s.outcome)}::jsonb, priority = ${Number(body.priority) || 100},
      is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${user.id}
    where id = ${body.id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true })
}
