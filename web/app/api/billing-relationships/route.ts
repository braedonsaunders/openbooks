import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { notFound } from '@/lib/api/responses'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/platform/business-date'
import { db, type SqlExecutor } from '@openbooks/engine/platform/database'
import { lockAndCheckOrgFeature } from '@openbooks/engine/organization/features'
import {
  ConsolidatedBillingError,
  resolveEffectiveBillingParties,
} from '@openbooks/engine/billing'
import {
  withScopeSnapshot,
} from '@openbooks/engine/organization/authority'
import { can, guardSubsidiaryScope, type Authz } from '../../../lib/authz'
import { listScopedPartyOptions } from '../../../lib/scoped-options'
import { isUuid } from '../../../lib/list-params'

export const runtime = 'nodejs'

type RelationshipInput = {
  id?: string
  childPartyId?: string
  billToPartyId?: string
  payerPartyId?: string
  effectiveFrom?: string | null
  effectiveTo?: string | null
  consolidationGroupId?: string | null
}

const relationshipDate = z.union([z.string(), z.null()])

const relationshipCreateBody = z.strictObject({
  childPartyId: z.string().uuid(),
  billToPartyId: z.string().uuid(),
  payerPartyId: z.string().uuid(),
  effectiveFrom: relationshipDate,
  effectiveTo: relationshipDate,
  consolidationGroupId: z.string().uuid().nullable().optional(),
})

const relationshipPatchBody = z.strictObject({
  id: z.string().uuid(),
  childPartyId: z.string().uuid().optional(),
  billToPartyId: z.string().uuid().optional(),
  payerPartyId: z.string().uuid().optional(),
  effectiveFrom: relationshipDate.optional(),
  effectiveTo: relationshipDate.optional(),
  consolidationGroupId: z.string().uuid().nullable().optional(),
})

function dateValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const text = String(value)
  // Strict calendar validation: V8's Date.parse rolls February 30 into
  // March, which would pass a naive guard and reach the daterange cast as a
  // 22008 from PostgreSQL (a 500 path) instead of the dates domain error.
  return isIsoCalendarDate(text) ? text : undefined
}

/** Uniform not-found for record-level scope denials on this surface. */
function scopeNotFound() {
  return notFound('billing relationship')
}

const RELATIONSHIP_ERRORS = {
  scope: 'Choose one billed customer to manage billing for.',
  invalidRecord: 'Choose valid records for the billing relationship.',
  dates: 'Use valid calendar dates for the billing window.',
  dateOrder: 'The billing window cannot end before it starts.',
  references: 'Choose customers and a group from this organization.',
  noRedirect: 'A billing relationship must redirect billing somewhere — choose a bill-to or payer different from the customer.',
  group: 'The consolidation group must be active and bill to this relationship’s payer — pick one of the payer’s groups, or leave it empty to bill standalone.',
  overlap: 'This customer already bills through another payer for part of that window — close the existing window first (set its end date), then add the new one.',
  save: 'The billing relationship could not be saved.',
} as const

type RelationshipErrorCode = keyof typeof RELATIONSHIP_ERRORS

function refused(code: RelationshipErrorCode, status = 400) {
  return NextResponse.json(
    { errorCode: code, error: RELATIONSHIP_ERRORS[code] ?? RELATIONSHIP_ERRORS.save },
    { status },
  )
}

/**
 * Prove the billed customer visible to the caller, locking the party row so
 * a concurrent rehome cannot move the relationship between the check and
 * the write. Parties scope under the shared-party policy (a null-subsidiary
 * party is org-wide, never private). Returns 'missing' when the record is
 * absent, 'hidden' when it sits outside the caller's subsidiaries, and
 * 'visible' otherwise.
 */
async function billedCustomerVisibility(
  tx: SqlExecutor,
  orgId: string,
  gate: Authz,
  customerId: string,
): Promise<'visible' | 'missing' | 'hidden'> {
  const party = (await tx.execute<{ subsidiaryId: string | null }>(sql`
    select p.subsidiary_id as "subsidiaryId"
      from parties p
     where p.org_id = ${orgId} and p.id = ${customerId}
     for share of p`)).rows[0]
  if (!party) return 'missing'
  return guardSubsidiaryScope(gate, party.subsidiaryId, { orgWideNull: true }) ? 'hidden' : 'visible'
}

/**
 * Billing relationships on one customer drawer — the hierarchy edges that
 * separate the service-to child from the bill-to recipient and the AR
 * payer, with the consolidation group the charge consolidates through.
 */
export const GET = defineRoute({
  permission: 'parties.read',
  feature: 'consolidatedBilling',
  handler: async ({ request: req, authz: gate }) => {
  const { orgId } = gate.user
  const url = new URL(req.url)
  const childPartyId = url.searchParams.get('childPartyId') ?? ''
  if (!isUuid(childPartyId)) return scopeNotFound()
  return withScopeSnapshot(orgId, async () => {
    const today = await businessToday(orgId)
    const child = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select p.subsidiary_id as "subsidiaryId"
        from parties p
       where p.org_id = ${orgId} and p.id = ${childPartyId}`)).rows[0]
    if (!child) return scopeNotFound()
    if (gate.allowedSubsidiaryIds !== null
      && guardSubsidiaryScope(gate, child.subsidiaryId, { orgWideNull: true })) {
      return scopeNotFound()
    }
    // Sequential: the snapshot holds one connection, and overlapping
    // queries on it are deprecated by the driver.
    const relationships = await db.execute(sql`
      select r.id, r.bill_to_party_id as "billToPartyId", b.display_name as "billToName",
             r.payer_party_id as "payerPartyId", p.display_name as "payerName",
             r.consolidation_group_id as "groupId", g.code as "groupCode", g.name as "groupName",
             r.effective_from::text as "effectiveFrom", r.effective_to::text as "effectiveTo"
        from customer_billing_relationships r
        join parties b on b.id = r.bill_to_party_id and b.org_id = r.org_id
        join parties p on p.id = r.payer_party_id and p.org_id = r.org_id
        left join consolidation_groups g on g.id = r.consolidation_group_id and g.org_id = r.org_id
       where r.org_id = ${orgId} and r.child_party_id = ${childPartyId}
       order by r.effective_from desc`)
    const children = await db.execute(sql`
      select r.child_party_id as "childPartyId", c.display_name as "childName",
             r.bill_to_party_id as "billToPartyId", r.payer_party_id as "payerPartyId",
             r.effective_from::text as "effectiveFrom", r.effective_to::text as "effectiveTo",
             g.code as "groupCode"
        from customer_billing_relationships r
        join parties c on c.id = r.child_party_id and c.org_id = r.org_id
        left join consolidation_groups g on g.id = r.consolidation_group_id and g.org_id = r.org_id
       where r.org_id = ${orgId} and (r.bill_to_party_id = ${childPartyId} or r.payer_party_id = ${childPartyId})
       order by c.display_name, r.effective_from desc
       limit 200`)
    const groups = await db.execute(sql`
      select g.id, g.code, g.name, g.payer_party_id as "payerPartyId",
             g.cadence, g.cutoff_day as "cutoffDay", g.grouping
        from consolidation_groups g
       where g.org_id = ${orgId} and g.is_active
       order by g.code`)
    const parties = await listScopedPartyOptions(orgId, gate.allowedSubsidiaryIds, { role: 'customer', activeOnly: true })
    let summary: Record<string, unknown>
    try {
      const parties0 = await resolveEffectiveBillingParties(orgId, childPartyId, today, null)
      const names = (await db.execute<{ id: string; name: string }>(sql`
        select p.id, p.display_name as name from parties p
         where p.org_id = ${orgId} and p.id in (${parties0.billToPartyId}, ${parties0.payerPartyId})`)).rows
      const byId = new Map(names.map((n) => [n.id, n.name]))
      const group = parties0.consolidationGroupId
        ? (await db.execute<{ code: string; name: string; cadence: string }>(sql`
            select code, name, cadence from consolidation_groups
             where org_id = ${orgId} and id = ${parties0.consolidationGroupId}`)).rows[0]
        : null
      summary = {
        billToPartyId: parties0.billToPartyId,
        billToName: byId.get(parties0.billToPartyId) ?? '',
        payerPartyId: parties0.payerPartyId,
        payerName: byId.get(parties0.payerPartyId) ?? '',
        consolidationGroupId: parties0.consolidationGroupId,
        groupCode: group?.code ?? null,
        groupName: group?.name ?? null,
        groupCadence: group?.cadence ?? null,
      }
    } catch (error) {
      if (error instanceof ConsolidatedBillingError) return apiErrorResponse(error)
      throw error
    }
    return NextResponse.json({
      summary,
      relationships: relationships.rows,
      children: children.rows,
      groups: groups.rows,
      parties: parties.map((p) => ({ id: p.id, name: p.display_name })),
      canManage: can(gate, 'documents.manage'),
    })
  })
  },
})

async function normalizedInput(
  body: RelationshipInput,
  orgId: string,
  gate: Authz,
  allowed: ReadonlySet<string> | null,
  rowId: string | undefined,
  tx: SqlExecutor,
) {
  const unrestricted = allowed === null
  // Overlapping windows for one child are refused, never resolved
  // arbitrarily — serialize the check and the write on the child so two
  // concurrent creates cannot both pass the preflight (there is no storage
  // exclusion to arbitrate them).
  const lockChild = body.childPartyId ? String(body.childPartyId) : null
  if (rowId && !lockChild) {
    const current = (await tx.execute<{ childPartyId: string }>(sql`
      select child_party_id as "childPartyId"
        from customer_billing_relationships where id = ${rowId} and org_id = ${orgId}`)).rows[0]
    if (!current) return { errorCode: 'save' } as const
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'billing-relationship:' + orgId + ':' + current.childPartyId}, 0))`)
  } else if (lockChild) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'billing-relationship:' + orgId + ':' + lockChild}, 0))`)
  }
  if (!(await lockAndCheckOrgFeature(tx, orgId, 'consolidatedBilling'))) {
    return { errorCode: 'featureOff' } as const
  }
  let values = body
  if (rowId) {
    const current = ((await tx.execute<RelationshipInput>(sql`
      select child_party_id as "childPartyId", bill_to_party_id as "billToPartyId",
             payer_party_id as "payerPartyId",
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
             consolidation_group_id as "consolidationGroupId"
        from customer_billing_relationships where id = ${rowId} and org_id = ${orgId} for update`)))
    if (!current.rows[0]) return { errorCode: 'save' } as const
    values = { ...current.rows[0], ...body }
    // The stored row's own customer must already be visible — a restricted
    // caller alters only their own subsidiaries' billing, and the uniform
    // 'save' answers exactly like a missing row.
    const stored = await billedCustomerVisibility(
      tx, orgId, gate, String(current.rows[0].childPartyId),
    )
    if (stored !== 'visible') return { errorCode: 'save' } as const
  }
  const childPartyId = String(values.childPartyId ?? '')
  const billToPartyId = String(values.billToPartyId ?? '')
  const payerPartyId = String(values.payerPartyId ?? '')
  const effectiveFrom = dateValue(values.effectiveFrom)
  const effectiveTo = dateValue(values.effectiveTo)
  const consolidationGroupId = values.consolidationGroupId ? String(values.consolidationGroupId) : null
  if (!isUuid(childPartyId) || !isUuid(billToPartyId) || !isUuid(payerPartyId)
    || (consolidationGroupId && !isUuid(consolidationGroupId))) {
    return { errorCode: 'invalidRecord' } as const
  }
  if (effectiveFrom === undefined || effectiveTo === undefined) return { errorCode: 'dates' } as const
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) return { errorCode: 'dateOrder' } as const
  if (childPartyId === billToPartyId && childPartyId === payerPartyId) return { errorCode: 'noRedirect' } as const
  // The requested customer must be visible first: a restricted caller
  // probing a hidden or missing record reads the same uniform not-found,
  // while an unrestricted caller is unaffected.
  const requested = await billedCustomerVisibility(tx, orgId, gate, childPartyId)
  if (requested !== 'visible') {
    if (unrestricted) return { errorCode: 'references' } as const
    return { errorCode: 'notFound' } as const
  }
  // Record validity, unchanged for every caller alike: all three parties
  // belong to this organization, and the group — when named — is active and
  // bills to this relationship's payer. A group naming another payer would
  // silently never apply (resolution drops a group whose payer differs),
  // so it is refused by name instead of saved as applicable.
  const refs = ((await tx.execute(sql`
    select
      exists(select 1 from parties where id = ${childPartyId} and org_id = ${orgId}) as child_ok,
      exists(select 1 from parties where id = ${billToPartyId} and org_id = ${orgId}) as bill_to_ok,
      exists(select 1 from parties where id = ${payerPartyId} and org_id = ${orgId}) as payer_ok,
      ${consolidationGroupId
        ? sql`exists(select 1 from consolidation_groups
                      where id = ${consolidationGroupId} and org_id = ${orgId}
                        and is_active and payer_party_id = ${payerPartyId})`
        : sql`true`} as group_ok`)))
  if (!refs.rows[0]?.child_ok || !refs.rows[0]?.bill_to_ok
    || !refs.rows[0]?.payer_ok || !refs.rows[0]?.group_ok) {
    return { errorCode: consolidationGroupId && refs.rows[0]?.child_ok
      && refs.rows[0]?.bill_to_ok && refs.rows[0]?.payer_ok ? 'group' : 'references' } as const
  }
  const overlap = ((await tx.execute(sql`
    select 1 from customer_billing_relationships
     where org_id = ${orgId} and id is distinct from ${rowId ?? null}
       and child_party_id = ${childPartyId}
       and daterange(effective_from, effective_to, '[]') &&
           daterange(${effectiveFrom}::date, ${effectiveTo}::date, '[]')
     limit 1`)))
  if (overlap.rows.length) return { errorCode: 'overlap' } as const
  return { values: { childPartyId, billToPartyId, payerPartyId, effectiveFrom, effectiveTo, consolidationGroupId } } as const
}

export const POST = defineRoute({
  permission: 'documents.manage',
  feature: 'consolidatedBilling',
  body: relationshipCreateBody,
  invalidBodyStatus: 400,
  handler: async ({ authz: gate, body }) => {
  const input: RelationshipInput = body
  const outcome = await db.transaction(async (tx) => {
    const parsed = await normalizedInput(input, gate.user.orgId, gate, gate.allowedSubsidiaryIds, undefined, tx)
    if ('errorCode' in parsed) return parsed
    const v = parsed.values
    const inserted = await tx.execute(sql`
      insert into customer_billing_relationships
        (org_id, child_party_id, bill_to_party_id, payer_party_id,
         effective_from, effective_to, consolidation_group_id, created_by, updated_by)
      values (${gate.user.orgId}, ${v.childPartyId}, ${v.billToPartyId}, ${v.payerPartyId},
              ${v.effectiveFrom}, ${v.effectiveTo}, ${v.consolidationGroupId}, ${gate.user.id}, ${gate.user.id})
      returning *`)
    const after = inserted.rows[0]
    if (!after) throw new Error('billing relationship insert returned no row')
    const id = String(after.id)
    await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'customer_billing_relationships', ${id}, 'insert',
              ${JSON.stringify({ before: null, after })}::jsonb, ${gate.user.id})`)
    return { id } as const
  })
  if (!('id' in outcome)) {
    if (outcome.errorCode === 'notFound') return scopeNotFound()
    if (outcome.errorCode === 'featureOff') {
      return NextResponse.json(
        { errorCode: outcome.errorCode, error: 'Consolidated billing was turned off before this change could be saved — turn it back on under Company Settings → Features, then retry.' },
        { status: 409 },
      )
    }
    return refused(outcome.errorCode as RelationshipErrorCode)
  }
  return NextResponse.json({ id: outcome.id })
  },
})

export const PATCH = defineRoute({
  permission: 'documents.manage',
  feature: 'consolidatedBilling',
  body: relationshipPatchBody,
  invalidBodyStatus: 400,
  handler: async ({ authz: gate, body }) => {
  const input: RelationshipInput = body
  const id = input.id!
  const outcome = await db.transaction(async (tx) => {
    const parsed = await normalizedInput(input, gate.user.orgId, gate, gate.allowedSubsidiaryIds, id, tx)
    if ('errorCode' in parsed) return parsed
    const v = parsed.values
    const before = (await tx.execute(sql`
      select * from customer_billing_relationships where id = ${id} and org_id = ${gate.user.orgId} for update`)).rows[0]
    if (!before) return { errorCode: 'save' } as const
    const updated = (await tx.execute(sql`update customer_billing_relationships
         set child_party_id = ${v.childPartyId}, bill_to_party_id = ${v.billToPartyId},
             payer_party_id = ${v.payerPartyId}, effective_from = ${v.effectiveFrom}, effective_to = ${v.effectiveTo},
             consolidation_group_id = ${v.consolidationGroupId},
             updated_at = now(), updated_by = ${gate.user.id}
       where id = ${id} and org_id = ${gate.user.orgId}
       returning *`)).rows[0]
    if (!updated) throw new Error('billing relationship update returned no row')
    await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'customer_billing_relationships', ${id}, 'update',
              ${JSON.stringify({ before, after: updated })}::jsonb, ${gate.user.id})`)
    return { id } as const
  })
  if (!('id' in outcome)) {
    if (outcome.errorCode === 'save' || outcome.errorCode === 'notFound') {
      return NextResponse.json({ errorCode: outcome.errorCode }, { status: 404 })
    }
    if (outcome.errorCode === 'featureOff') {
      return NextResponse.json(
        { errorCode: outcome.errorCode, error: 'Consolidated billing was turned off before this change could be saved — turn it back on under Company Settings → Features, then retry.' },
        { status: 409 },
      )
    }
    return refused(outcome.errorCode as RelationshipErrorCode)
  }
  return NextResponse.json({ id: outcome.id })
  },
})

export const DELETE = defineRoute({
  permission: 'documents.manage',
  feature: 'consolidatedBilling',
  handler: async ({ request: req, authz: gate }) => {
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!isUuid(id)) return NextResponse.json({ errorCode: 'save' }, { status: 404 })
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'billing-relationship:' + gate.user.orgId + ':' + id}, 0))`)
    if (!(await lockAndCheckOrgFeature(tx, gate.user.orgId, 'consolidatedBilling'))) {
      return { errorCode: 'featureOff' } as const
    }
    const before = (await tx.execute(sql`
      select * from customer_billing_relationships where id = ${id} and org_id = ${gate.user.orgId} for update`)).rows[0] as
      | { child_party_id: string | null }
      | undefined
    if (!before) return { errorCode: 'save' } as const
    // A restricted caller deletes only their own subsidiaries' billing —
    // the uniform 'save' answers exactly like a missing row.
    const stored = await billedCustomerVisibility(
      tx, gate.user.orgId, gate, before.child_party_id ? String(before.child_party_id) : '',
    )
    if (stored !== 'visible') return { errorCode: 'save' } as const
    const removed = (await tx.execute(sql`delete from customer_billing_relationships
      where id = ${id} and org_id = ${gate.user.orgId} returning id`)).rows[0]
    if (!removed) throw new Error('billing relationship delete returned no row')
    await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'customer_billing_relationships', ${id}, 'delete',
              ${JSON.stringify({ before, after: null })}::jsonb, ${gate.user.id})`)
    return { ok: true } as const
  })
  if ('errorCode' in outcome) {
    if (outcome.errorCode === 'featureOff') {
      return NextResponse.json(
        { errorCode: outcome.errorCode, error: 'Consolidated billing was turned off before this change could be saved — turn it back on under Company Settings → Features, then retry.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ errorCode: outcome.errorCode }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
  },
})
