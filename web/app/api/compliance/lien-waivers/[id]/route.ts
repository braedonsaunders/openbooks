import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardSubsidiaryScope } from '@/lib/authz';
import {
  guardLienWaiverFeature,
  lienWaiverPrintData,
  loadLienWaiverPrintSource,
} from '@/lib/compliance'
import { complianceWriteFailure } from '@/lib/compliance-errors'
import type { LienWaiverExecutedSnapshot } from '@/lib/lien-waiver-form'
import { isUuid } from '@/lib/list-params'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { normalizeSubdivisionCode } from '@openbooks/engine/src/compliance/lien-jurisdictions.ts'
import { canonicalDecimal } from '@/lib/exact-decimal'
import { moneyRefusal } from '@/lib/payroll-decimal-refusal'
import { notFound } from "@/lib/api/responses";

const requestAmount = z.union([
  z.string().superRefine((value, ctx) => {
    const exact = canonicalDecimal(value, 4)
    if (exact === null || wholeDigits(exact) > 15) ctx.addIssue({ code: 'custom', message: moneyRefusal('Amount', value) })
  }),
  z.literal(''),
  z.null(),
]).optional()
const updateFields = {
  throughDate: z.string().refine(isIsoCalendarDate, 'throughDate must be a real calendar date (YYYY-MM-DD)').nullable().optional(),
  amount: requestAmount,
  jurisdiction: z.string().trim().max(20).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}
const requestBodySchema = z.preprocess(
  (value) => value && typeof value === 'object' && !Array.isArray(value) && !('action' in value)
    ? { ...value, action: 'update' }
    : value,
  z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('request') }),
    z.strictObject({ action: z.literal('receive') }),
    z.strictObject({
      action: z.literal('sign'),
      signedByName: z.string().trim().min(1, 'signedByName is required to record a signature').max(200),
      signedByTitle: z.string().trim().max(200).nullable().optional(),
      signedAt: z.string().refine(isIsoCalendarDate, 'signedAt must be a real calendar date (YYYY-MM-DD)').nullable().optional(),
      notarized: z.boolean().nullable().optional(),
    }),
    z.strictObject({ action: z.literal('reject'), reason: z.string().trim().min(1, 'reason is required to reject a waiver').max(2000) }),
    z.strictObject({ action: z.literal('void'), reason: z.string().trim().min(1, 'reason is required to void a waiver').max(2000) }),
    z.strictObject({ action: z.literal('update'), ...updateFields })
      .refine((body) => Object.keys(updateFields).some((field) => body[field as keyof typeof body] !== undefined), {
        error: 'provide at least one lien waiver field to update',
      }),
  ], { error: 'action must be request, receive, sign, reject, void, or update' }),
)



export const runtime = 'nodejs'

/** Whole-digit width of a canonical decimal: numeric(19,4) holds 15. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

type Action = 'request' | 'receive' | 'sign' | 'reject' | 'void' | 'update'

/** Forward-only lifecycle. A waiver never walks back into an earlier state. */
const ALLOWED_FROM: Record<Action, string[]> = {
  request: ['draft'],
  receive: ['draft', 'requested'],
  sign: ['draft', 'requested', 'received'],
  reject: ['requested', 'received'],
  void: ['draft', 'requested', 'received', 'signed', 'rejected'],
  update: ['draft', 'requested', 'received']
}

/**
 * Drive one lien waiver through its lifecycle.
 *
 * `sign` is the consequential transition — it is what releases a blocked
 * payment — so it demands the signatory's name and the date they signed, and it
 * stamps who in this organisation attested to receiving the executed document.
 * A signed waiver is then immutable except for voiding: editing the amount or
 * through-date of an executed release would silently change what a
 * subcontractor gave up.
 */
export const PATCH = defineRoute({
  permission: 'compliance.manage',
  feature: { none: 'No optional feature applies to this permission-governed endpoint.' },
  params: z.object({ "id": z.string() }),
  handler: async ({ request: req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const blocked = await guardLienWaiverFeature(gate.user.orgId)
    if (blocked) return blocked
    const { orgId, id: actorId } = gate.user
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const parsedBody = await parseJsonBody(req, requestBodySchema)
    if (!parsedBody.ok) return parsedBody.response
    const body = parsedBody.data
    const action: Action = body.action
    if (!Object.hasOwn(ALLOWED_FROM, action)) {
      return NextResponse.json({ error: 'unknown lien waiver action' }, { status: 400 })
    }

    try {
      const result = await withOrgTransaction(orgId, async () => {
        // Lock the current row before validating its lifecycle. The lock makes
        // the status snapshot, mutation, and audit one serializable unit: a
        // racing request sees the committed state after the first request and
        // cannot overwrite a signed/void waiver.
        const before = await db.execute<Record<string, unknown>>(sql`
          select lw.id, lw.status, lw.waiver_number, lw.waiver_type, lw.through_date,
                 lw.amount, lw.currency, lw.direction,
                 pj.subsidiary_id as "subsidiaryId"
            from lien_waivers lw
            join projects pj on pj.id = lw.project_id and pj.org_id = lw.org_id
           where lw.org_id = ${orgId} and lw.id = ${id}
           for update of lw
        `)
        const waiver = before.rows[0]
        if (!waiver) return notFound("record")
        const denied = guardSubsidiaryScope(gate, waiver.subsidiaryId as string | null | undefined)
        if (denied) return denied
        if (!ALLOWED_FROM[action].includes(String(waiver.status))) {
          return NextResponse.json(
            {
              error: `a ${waiver.status} waiver cannot be ${action === 'update' ? 'edited' : action + 'ed'}`
            },
            { status: 422 }
          )
        }

        if (body.action === 'request') {
          await db.execute(sql`
            update lien_waivers
               set status = 'requested', requested_at = now(), requested_by = ${actorId},
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id}`)
        } else if (body.action === 'receive') {
          await db.execute(sql`
            update lien_waivers set status = 'received', updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id}`)
        } else if (body.action === 'sign') {
          const name = (body.signedByName ?? '').trim()
          if (!name) {
            return NextResponse.json({ error: 'the name of the person who signed is required' }, { status: 400 })
          }
          const signedAt = body.signedAt ?? (await businessToday(orgId))
          // The sign stamps this straight to timestamptz: a non-calendar date
          // would otherwise die in Postgres with a raw driver failure.
          if (!isIsoCalendarDate(signedAt)) {
            return NextResponse.json({ error: 'signed date must be a real calendar date (YYYY-MM-DD)' }, { status: 400 })
          }
          // Evidence of the attestation, not a digital signature: who in this
          // organisation recorded the executed document, and when.
          const evidence = {
            method: 'recorded_in_app',
            attestedBy: actorId,
            attestedAt: new Date().toISOString(),
            signedByName: name,
            signedByTitle: body.signedByTitle ?? null
          }
          await db.execute(sql`
            update lien_waivers
               set status = 'signed', signed_by_name = ${name},
                   signed_by_title = ${body.signedByTitle ?? null},
                   signed_at = ${`${signedAt}T00:00:00Z`}::timestamptz,
                   notarized = coalesce(${body.notarized ?? null}, notarized),
                   signature = ${JSON.stringify(evidence)}::jsonb,
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id}`)
          // Freeze the executed release: every value the printable waiver
          // shows, resolved names included, as it stood at signing. Later
          // renames cannot rewrite it, because the printable route serves
          // this image instead of the live rows.
          const source = await loadLienWaiverPrintSource(orgId, id)
          if (!source) throw new Error('signed waiver vanished mid-transition')
          const frozen = lienWaiverPrintData(source)
          const snapshot: LienWaiverExecutedSnapshot = {
            version: 1,
            takenAt: new Date().toISOString(),
            takenBy: actorId,
            orgName: frozen.orgName,
            data: frozen.data,
          }
          await db.execute(sql`
            update lien_waivers
               set executed_snapshot = ${JSON.stringify(snapshot)}::jsonb,
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id}`)
        } else if (body.action === 'reject') {
          const reason = (body.reason ?? '').trim()
          if (!reason) return NextResponse.json({ error: 'a rejection needs a reason' }, { status: 400 })
          await db.execute(sql`
            update lien_waivers
               set status = 'rejected', rejected_reason = ${reason},
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id}`)
        } else if (body.action === 'void') {
          const reason = (body.reason ?? '').trim()
          if (!reason) return NextResponse.json({ error: 'voiding needs a reason' }, { status: 400 })
          await db.execute(sql`
            update lien_waivers
               set status = 'void', void_reason = ${reason}, updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id}`)
        } else {
          const amountRaw = body.amount == null || body.amount === '' ? null : canonicalDecimal(body.amount, 4)
          // lien_waivers.amount is numeric(19,4): refuse whole-digit widths the
          // column cannot hold before any write.
          if (amountRaw !== null && wholeDigits(amountRaw) > 15) {
            return NextResponse.json({ error: 'Amount is out of range — at most 15 whole digits fit the ledger' }, { status: 422 })
          }
          // through_date casts straight to date: require a real calendar day
          // before any write, instead of leaking the cast failure.
          if (body.throughDate !== undefined && body.throughDate !== null && !isIsoCalendarDate(body.throughDate)) {
            return NextResponse.json({ error: 'through date must be a real calendar date (YYYY-MM-DD)' }, { status: 400 })
          }
          if (body.amount != null && body.amount !== '' && amountRaw === null) {
            return NextResponse.json({ error: moneyRefusal('Amount', body.amount) }, { status: 422 })
          }
          const amount = amountRaw === null ? null : normalizeMoney(amountRaw)
          // The jurisdiction is an ISO 3166-2 subdivision code, validated like
          // the create verb: an unknown code refuses instead of storing text
          // the evaluator can never match against a project site.
          let jurisdiction: string | null | undefined
          if (body.jurisdiction != null && body.jurisdiction !== '') {
            const canonical = normalizeSubdivisionCode(body.jurisdiction)
            if (!canonical) {
              return NextResponse.json(
                { error: `unknown jurisdiction ${JSON.stringify(body.jurisdiction)} — use an ISO 3166-2 subdivision code (e.g. US-CA)` },
                { status: 422 },
              )
            }
            jurisdiction = canonical
          }
          await db.execute(sql`
            update lien_waivers
               set through_date = coalesce(${body.throughDate ?? null}::date, through_date),
                   amount = ${amount === null ? sql`amount` : sql`${amount}`},
                   jurisdiction = coalesce(${jurisdiction ?? null}, jurisdiction),
                   notes = coalesce(${body.notes ?? null}, notes),
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id}`)
        }
        await db.execute(sql`
          insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'lien_waivers', ${id}, ${action === 'update' ? 'update' : action},
                  ${JSON.stringify({ before: waiver, after: body })}::jsonb, ${actorId})`)
        return NextResponse.json({ id })
      })
      return result
    } catch (e) {
      return complianceWriteFailure(e)
    }

  },
})
