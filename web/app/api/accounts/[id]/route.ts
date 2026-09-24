import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { ACCOUNT_TYPES } from '@openbooks/schema'
import { guardPermission, guardSubsidiaryScope, guardUnrestrictedScope, subsidiaryScopeAllows } from '../../../../lib/authz'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../../lib/features'
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { assetBankHygieneWarning } from '../../../../lib/accounts-hygiene'
import { isUuid } from '../../../../lib/list-params'
import { loadAccount, orgBaseCurrency } from '../_lib'
import { accountInputFields } from '../_input'

export const runtime = 'nodejs'

const CURRENCY_RE = /^[A-Z]{3}$/

// Validate the complete input before normalization or financial policy checks.
const patchBodySchema = z.looseObject({
  ...accountInputFields,
  name: z.string().optional(),
})

function bad(error: string, field?: string) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status: 422 })
}

/** A rule violated inside the mutation transaction, mapped to its 422 body after rollback. */
class PatchInvalid extends Error {
  constructor(readonly code: string, readonly field?: string) {
    super(code)
  }
}

class PatchNotFound extends Error {}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

async function belongsToOrg(table: 'accounts' | 'subsidiaries', id: string, orgId: string) {
  const result = (await db.execute(sql`
    select 1 from ${sql.raw(table)} where id = ${id} and org_id = ${orgId}
  `))
  return Boolean(result.rows[0])
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const payload = await loadAccount(id, gate.user.orgId)
  if (!payload) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  // Entity-owned accounts are visible only inside the caller's scope; the
  // shared chart (null subsidiary) reads for everyone.
  const denied = guardSubsidiaryScope(gate, payload.account.subsidiary_id as string | null, { orgWideNull: true })
  if (denied) return denied
  return NextResponse.json(payload)
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const existingPayload = await loadAccount(id, gate.user.orgId)
  if (!existingPayload) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const existing = (existingPayload.account)
  // Reads hide out-of-scope entity accounts; the shared chart reads for all.
  const readDenied = guardSubsidiaryScope(gate, existing.subsidiary_id as string | null, { orgWideNull: true })
  if (readDenied) return readDenied
  // The shared chart has no subsidiary lineage, so any write to it acts on
  // every entity at once: restricted callers cannot write it.
  if (existing.subsidiary_id == null) {
    const orgWideDenied = guardUnrestrictedScope(gate)
    if (orgWideDenied) return orgWideDenied
  }
  const parsedBody = await parseJsonBody(request, patchBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  // Multi-currency off refuses settlement-currency writes — except the one the
  // reconcilable invariant forces: a reconcilable account must carry a
  // currency, and a single-currency org has only its base (the same base-only
  // pass-through as transaction import).
  const nextReconcilable = body.reconcilable ?? Boolean(existing.reconcilable)
  if (body.currencyRestriction !== undefined && !(await isFeatureEnabled(gate.user.orgId, 'multiCurrency'))) {
    const restriction = textOrNull(body.currencyRestriction)?.toUpperCase() ?? null
    const base = await orgBaseCurrency(gate.user.orgId)
    if (!(nextReconcilable && restriction && base && restriction === base)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
  }
  if (body.eliminate !== undefined && !(await subsidiaryFeatureEnabled(gate.user.orgId))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  if (body.name !== undefined && typeof body.name !== 'string') return bad('name_required', 'name')
  const name = body.name === undefined ? undefined : body.name.trim()
  if (name !== undefined && !name) return bad('name_required', 'name')
  if (body.type !== undefined && !ACCOUNT_TYPES.includes(body.type as (typeof ACCOUNT_TYPES)[number])) {
    return bad('invalid_type', 'type')
  }
  if (body.type !== undefined && body.type !== existing.type && existingPayload.hasTransactions) {
    return bad('type_has_transactions', 'type')
  }
  const nextType = body.type ?? String(existing.type)

  let parentId: string | null | undefined
  if (body.parentId !== undefined) {
    parentId = textOrNull(body.parentId)
    if (parentId && (!isUuid(parentId) || parentId === id)) return bad('invalid_parent', 'parentId')
  }
  const effectiveParentId = parentId !== undefined ? parentId : (existing.parent_id as string | null)
  if (effectiveParentId && body.type !== undefined && body.parentId === undefined) {
    const parent = (await db.execute<{ type: string; subsidiary_id: string | null }>(sql`
      select type, subsidiary_id from accounts
       where id = ${effectiveParentId} and org_id = ${gate.user.orgId}
    `))
    if (!parent.rows[0] || parent.rows[0].type !== nextType) {
      return bad('parent_type_mismatch', 'type')
    }
    // The hierarchy places the account: a parent the caller cannot see is the
    // same as a missing one.
    if (guardSubsidiaryScope(gate, parent.rows[0].subsidiary_id, { orgWideNull: true })) {
      return bad('parent_type_mismatch', 'type')
    }
  }

  const nextSummary = body.isSummary ?? Boolean(existing.is_summary)
  if (nextSummary && nextReconcilable) return bad('summary_reconcilable_conflict')
  if (body.isSummary === true && existingPayload.hasTransactions) return bad('summary_has_transactions', 'isSummary')
  if (body.isSummary === false && existingPayload.childCount > 0) return bad('summary_has_children', 'isSummary')
  if (body.isActive === false && existingPayload.activeChildCount > 0) return bad('inactive_has_children', 'isActive')

  let currencyRestriction: string | null | undefined
  if (body.currencyRestriction !== undefined) {
    currencyRestriction = textOrNull(body.currencyRestriction)?.toUpperCase() ?? null
    if (currencyRestriction && !CURRENCY_RE.test(currencyRestriction)) {
      return bad('invalid_currency', 'currencyRestriction')
    }
    if (currencyRestriction) {
      const currency = (await db.execute(sql`select 1 from currencies where code = ${currencyRestriction}`))
      if (!currency.rows[0]) return bad('invalid_currency', 'currencyRestriction')
    }
  }
  // Storage requires reconcilable accounts to carry a settlement currency
  // (accounts_reconcilable_currency_required). Judge the effective pair —
  // the request's currency over the stored one — so neither enabling the flag
  // nor clearing the currency can reach the database as a raw error.
  const effectiveCurrency = currencyRestriction !== undefined
    ? currencyRestriction
    : (existing.currency_restriction as string | null)
  if (nextReconcilable && !effectiveCurrency) {
    return bad('reconcilable_currency_required', 'currencyRestriction')
  }

  let subsidiaryId: string | null | undefined
  if (body.subsidiaryId !== undefined) {
    subsidiaryId = textOrNull(body.subsidiaryId)
    if (subsidiaryId && (!isUuid(subsidiaryId) || !(await belongsToOrg('subsidiaries', subsidiaryId, gate.user.orgId)))) {
      return bad('invalid_subsidiary', 'subsidiaryId')
    }
    // A reassignment needs scope over the new subsidiary too (the old one was
    // checked above); moving onto the shared chart is an org-wide write.
    const targetDenied = subsidiaryId
      ? guardSubsidiaryScope(gate, subsidiaryId)
      : guardUnrestrictedScope(gate)
    if (targetDenied) return targetDenied
  }

  let requiredDimensions: string[] | undefined
  if (body.requiredDimensions !== undefined) {
    const definitions = (await db.execute<{ key: string }>(sql`
      select key from segment_definitions
       where org_id = ${gate.user.orgId} and is_active and allow_account_requirement
    `))
    const allowed = new Set(['party', ...definitions.rows.map((row) => row.key)])
    if (!Array.isArray(body.requiredDimensions) || body.requiredDimensions.some((d) => typeof d !== 'string' || !allowed.has(d))) {
      return bad('invalid_dimensions', 'requiredDimensions')
    }
    requiredDimensions = [...new Set(body.requiredDimensions)]
  }

  let custom: Record<string, unknown> | undefined
  if (body.custom !== undefined) {
    // PATCH custom values are partial: validate the effective bag so an
    // omitted required field can be satisfied by its stored value. Keep
    // unknown/system keys intact while applying the cleaned submitted
    // values, matching the shared entity-writer contract. The OCC guard on
    // updated_at below rejects the write if a concurrent edit moved the
    // stored bag after this read.
    const existingCustom =
      existing.custom && typeof existing.custom === 'object'
        ? (existing.custom as Record<string, unknown>)
        : {}
    const patchDefs = await loadFieldDefs('accounts')
    const validated = validateCustomValues(patchDefs, { ...existingCustom, ...body.custom })
    if (!validated.ok) return bad('invalid_custom_fields', 'custom')
    // Supplied values only, so legacy bags written before this fence cannot
    // lock unrelated edits.
    const suppliedCustom: Record<string, unknown> = {}
    for (const key of Object.keys(body.custom)) {
      if (validated.cleaned[key] !== undefined) suppliedCustom[key] = validated.cleaned[key]
    }
    const unownedPatchRefs = await findUnownedCustomReferences(gate.user.orgId, patchDefs, suppliedCustom)
    if (unownedPatchRefs.length > 0) return bad('unknown_custom_reference', 'custom')
    custom = { ...existingCustom, ...validated.cleaned }
  }

  try {
    await db.transaction(async (tx) => {
      // Keep hierarchy serialization before any per-account row lock. Two
      // concurrent reparents otherwise hold their own row and can deadlock
      // when the hierarchy loser tries to inspect the winner's row.
      if (parentId !== undefined) {
        await tx.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${`accounts-hierarchy:${gate.user.orgId}`}, 0))
        `)
      }
      // Account-owned writes use the account row as their scope fence. Bank
      // statement import/reconciliation holds this same row lock while it
      // rechecks subsidiary ownership, so a rehome and account-scoped work
      // have one deterministic order.
      const locked = (await tx.execute<{
        subsidiary_id: string | null;
        unchanged: boolean;
      }>(sql`
        select subsidiary_id,
               updated_at = ${existing.updated_at} as unchanged
          from accounts
         where id = ${id} and org_id = ${gate.user.orgId}
         for update
      `)).rows[0]
      if (!locked || !subsidiaryScopeAllows(gate.allowedSubsidiaryIds, locked.subsidiary_id, { orgWideNull: true })) {
        throw new PatchNotFound()
      }
      if (!locked.unchanged) throw new Error('account_changed')
      if (parentId !== undefined) {
        if (parentId) {
          const parent = (await tx.execute<{ is_summary: boolean; type: string; subsidiary_id: string | null }>(sql`
            select is_summary, type, subsidiary_id from accounts
             where id = ${parentId} and org_id = ${gate.user.orgId}
          `))
          if (!parent.rows[0]?.is_summary) throw new PatchInvalid('parent_must_be_summary', 'parentId')
          if (parent.rows[0].type !== nextType) throw new PatchInvalid('parent_type_mismatch', 'parentId')
          if (!subsidiaryScopeAllows(gate.allowedSubsidiaryIds, parent.rows[0].subsidiary_id, { orgWideNull: true })) {
            throw new PatchInvalid('parent_must_be_summary', 'parentId')
          }
          const cycle = (await tx.execute(sql`
            with recursive descendants as (
              select id from accounts where id = ${id} and org_id = ${gate.user.orgId}
              union
              select child.id from accounts child
              join descendants d on child.parent_id = d.id
              where child.org_id = ${gate.user.orgId}
            )
            select 1 from descendants where id = ${parentId} limit 1
          `))
          if (cycle.rows[0]) throw new PatchInvalid('parent_cycle', 'parentId')
        }
      }
      const updated = (await tx.execute<Record<string, unknown>>(sql`
        update accounts set
          number = ${body.number !== undefined ? textOrNull(body.number) : sql`number`},
          name = ${name !== undefined ? name : sql`name`},
          type = ${body.type !== undefined ? body.type : sql`type`},
          description = ${body.description !== undefined ? textOrNull(body.description) : sql`description`},
          parent_id = ${parentId !== undefined ? parentId : sql`parent_id`},
          is_summary = ${body.isSummary !== undefined ? body.isSummary : sql`is_summary`},
          is_active = ${body.isActive !== undefined ? body.isActive : sql`is_active`},
          currency_restriction = ${currencyRestriction !== undefined ? currencyRestriction : sql`currency_restriction`},
          eliminate = ${body.eliminate !== undefined ? body.eliminate : sql`eliminate`},
          subsidiary_id = ${subsidiaryId !== undefined ? subsidiaryId : sql`subsidiary_id`},
          subsidiary_include_children = ${body.subsidiaryIncludeChildren !== undefined ? body.subsidiaryIncludeChildren : sql`subsidiary_include_children`},
          reconcilable = ${body.reconcilable !== undefined ? body.reconcilable : sql`reconcilable`},
          monetary = ${body.monetary !== undefined ? body.monetary : sql`monetary`},
          required_dimensions = ${requiredDimensions !== undefined ? JSON.stringify(requiredDimensions) : sql`required_dimensions`}::jsonb,
          custom = ${custom !== undefined ? JSON.stringify(custom) : sql`custom`}::jsonb,
          updated_at = now(), updated_by = ${gate.user.id}
         where id = ${id} and org_id = ${gate.user.orgId}
           and updated_at = ${existing.updated_at}
         returning *
      `))
      if (!updated.rows[0]) throw new Error('account_changed')
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${gate.user.orgId}, 'accounts', ${id}, 'update',
           ${JSON.stringify({ before: existing, after: updated.rows[0] })}::jsonb,
           ${gate.user.id}, ${request.headers.get('X-Request-Id')})
      `)
    })
  } catch (error) {
    if (error instanceof PatchNotFound) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (error instanceof PatchInvalid) return bad(error.code, error.field)
    const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined
    const constraint = cause && typeof cause === 'object'
      ? (cause as { constraint?: unknown }).constraint
      : undefined
    const message = error instanceof Error ? `${error.message} ${String(cause ?? '')}` : String(error)
    if (constraint === 'accounts_type_has_transactions' || message.includes('type cannot change after journal lines exist')) {
      return bad('type_has_transactions', 'type')
    }
    if (constraint === 'accounts_summary_has_transactions' || message.includes('summary classification cannot change after journal lines exist')) {
      return bad('summary_has_transactions', 'isSummary')
    }
    if (message.includes('accounts_org_number')) return bad('number_in_use', 'number')
    if (message.includes('account_changed')) {
      return NextResponse.json({ error: 'account_changed' }, { status: 409 })
    }
    throw error
  }

  const saved = await loadAccount(id, gate.user.orgId)
  // Effective values after the edit; a statement behind the account counts as
  // corroboration even when the name says nothing. The warning rides
  // alongside success — the edit is always saved.
  const backed = (await db.execute(sql`
    select 1 from bank_statements where org_id = ${gate.user.orgId} and account_id = ${id} limit 1`))
  const hygiene = assetBankHygieneWarning({
    type: nextType,
    name: name ?? String(existing.name),
    reconcilable: nextReconcilable,
    isSummary: nextSummary,
    hasStatements: Boolean(backed.rows[0]),
  })
  return NextResponse.json({ ...saved, warnings: hygiene ? [hygiene] : [] })
}
