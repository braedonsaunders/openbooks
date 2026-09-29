import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'

import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { updatePaymentBankProfile } from '@openbooks/engine/src/payments/operations.ts'
import { computeNextRunAt } from '@openbooks/engine/src/scripting/scripting.ts'

import { isFeatureEnabled } from '../../../../../../lib/features'
import { isUuid } from '../../../../../../lib/list-params'
import { normalizeCountryCode } from '../../../../../../lib/countries'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { canonicalDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { moneyRefusal } from '@openbooks/engine/src/money/decimal-refusal.ts'
import { subsidiaryVisibleFilter } from '../../../../../../lib/subsidiaries'
import { auditConfigChange } from '../../_lib'
import { notFound } from "@/lib/api/responses";

const countryPatchSchema = z.string().refine((value) => value.trim() === '' || normalizeCountryCode(value) !== null).nullable().optional()
const currencyPatchSchema = z.string().regex(/^(?:[A-Za-z]{3})?$/).optional()
const datePatchSchema = z.string().refine((value) => value === '' || isIsoCalendarDate(value)).optional()
const scheduleAmountSchema = z.string().superRefine((value, ctx) => {
  if (value !== '' && canonicalDecimal(value, 4) === null) {
    ctx.addIssue({ code: 'custom', message: moneyRefusal('Payment schedule amount', value) })
  }
})
const selectionCriteriaSchema = z.object({
  dueThroughDays: z.number().int().min(0).max(3650).optional(),
  minimumAmount: scheduleAmountSchema.optional(), maximumRunAmount: scheduleAmountSchema.optional(),
  captureDiscounts: z.boolean().optional(), applyCredits: z.boolean().optional(),
})
const requestBodySchema = z.object({
  "action": z.enum(["create_draft", "submit_for_approval"], { error: 'action must be create_draft or submit_for_approval' }).optional(),
  "bankAccountId": z.string().uuid().optional(),
  "contentType": z.string().optional(),
  "country": countryPatchSchema,
  "cron": z.string().optional(),
  "currency": currencyPatchSchema,
  "expiresOn": datePatchSchema,
  "fileExtension": z.string().optional(),
  "formatterScript": z.string().optional(),
  "isActive": z.boolean().optional(),
  "name": z.string().optional(),
  "paymentBankProfileId": z.string().uuid().optional(),
  "paymentFormatId": z.string().uuid().optional(),
  "selectionCriteria": selectionCriteriaSchema.optional(),
  "settings": z.record(z.string(), z.json()).optional(),
  "originatorSecrets": z.record(z.string(), z.string()).nullable().optional(),
  "sftpServerId": z.string().uuid().nullable().optional(),
  "sftpFolder": z.string().nullable().optional(),
  "requireRunApproval": z.boolean().optional(),
  "requireFileApproval": z.boolean().optional(),
  "autoRemittance": z.boolean().optional(),
  "signedOn": datePatchSchema,
  "status": z.enum(["pending", "active", "suspended", "revoked", "expired"], { error: 'status must be pending, active, suspended, revoked, or expired' }).optional(),
  "subsidiaryId": z.string().uuid().nullable().optional(),
  "timezone": z.string().optional(),
  "validFrom": datePatchSchema,
}).refine((body) => Object.keys(body).length > 0, 'At least one payment setting is required')



export const runtime = 'nodejs'

function optionalCountry(value: unknown): string | null | undefined {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  return normalizeCountryCode(value) ?? undefined
}

export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "resource": z.string(), "id": z.string() }),
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ request, body, params, authz: routeAuthz }) => {

    const gate = routeAuthz

    const { resource, id } = params
    if (!isUuid(id) || !['formats', 'profiles', 'schedules', 'mandates'].includes(resource)) {
      return notFound("record")
    }



    const patchFieldsByResource: Record<string, readonly string[]> = {
      formats: ['name', 'country', 'currency', 'fileExtension', 'contentType', 'formatterScript', 'isActive'],
      profiles: ['name', 'bankAccountId', 'paymentFormatId', 'subsidiaryId', 'country', 'currency', 'originatorSecrets', 'settings', 'sftpServerId', 'sftpFolder', 'requireRunApproval', 'requireFileApproval', 'autoRemittance', 'isActive'],
      schedules: ['name', 'paymentBankProfileId', 'cron', 'timezone', 'selectionCriteria', 'action', 'isActive'],
      mandates: ['status', 'signedOn', 'validFrom', 'expiresOn'],
    }
    const unsupportedFields = Object.keys(body).filter((field) => !patchFieldsByResource[resource]?.includes(field))
    if (unsupportedFields.length > 0) {
      return NextResponse.json({ error: `Unsupported ${resource} settings: ${unsupportedFields.join(', ')}` }, { status: 400 })
    }
    try {
      if (body.country !== undefined) {
        const country = optionalCountry(body.country)
        if (country === undefined) return NextResponse.json({ error: 'country must be a valid ISO country code' }, { status: 400 })
        body.country = country
      }
      if (resource === 'profiles') {
        // Profile currency is Multi-currency configuration. Turning that
        // switch off must refuse a write; omitting currency keeps the
        // stored profile.
        if (
          body.currency !== undefined &&
          !(await isFeatureEnabled(gate.user.orgId, 'multiCurrency'))
        ) {
          return notFound("record")
        }
        await updatePaymentBankProfile(id, gate.user.orgId, gate.user.id, body, gate.allowedSubsidiaryIds)
      } else if (resource === 'formats') {
        // Format currency is Multi-currency configuration. Turning that
        // switch off must refuse a write; omitting currency keeps the
        // stored format.
        if (
          body.currency !== undefined &&
          !(await isFeatureEnabled(gate.user.orgId, 'multiCurrency'))
        ) {
          return notFound("record")
        }
        // POST requires a non-empty name and formatter script. A blank PATCH
        // value would otherwise store '' / NULL: an empty name corrupts the
        // format contract, and a nulled script fails the next payment run
        // (renderPaymentFile throws for custom rails with no script).
        if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
          return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
        }
        if (body.formatterScript !== undefined
          && (typeof body.formatterScript !== 'string' || !body.formatterScript.trim())) {
          return NextResponse.json({ error: 'formatterScript cannot be empty' }, { status: 400 })
        }
        const formatWrite = await db.transaction(async (tx) => {
          // Lock the row before taking the audit snapshot. This serializes
          // concurrent edits so each audit event records the state immediately
          // preceding its own update rather than a stale pre-transaction read.
          const before = (await tx.execute<Record<string, unknown>>(sql`
            select * from payment_formats where id = ${id} and org_id = ${gate.user.orgId} and rail = 'custom' for update
          `))
          if (!before.rows[0]) return 'missing'
          const updated = (await tx.execute<Record<string, unknown>>(sql`
            update payment_formats set
              name = coalesce(${body.name?.trim() ?? null}, name),
              country = case when ${body.country === undefined} then country else ${body.country ?? null} end,
              currency = case when ${body.currency === undefined} then currency else ${body.currency?.trim().toUpperCase() || null} end,
              file_extension = coalesce(${body.fileExtension?.trim().replace(/^\./, '') ?? null}, file_extension),
              content_type = coalesce(${body.contentType?.trim() ?? null}, content_type),
              formatter_script = case when ${body.formatterScript === undefined} then formatter_script else ${body.formatterScript || null} end,
              is_active = coalesce(${body.isActive ?? null}, is_active), updated_at = now(), updated_by = ${gate.user.id}
            where id = ${id} and org_id = ${gate.user.orgId} and rail = 'custom'
            returning *
          `))
          if (!updated.rows[0]) return 'missing'
          await auditConfigChange(tx, gate.user.orgId, 'payment_formats', id, 'update',
            { before: before.rows[0], after: updated.rows[0] }, gate.user.id, request.headers.get('X-Request-Id'))
          return 'updated'
        })
        if (formatWrite === 'missing') {
          return NextResponse.json({ error: 'built-in payment formats are read-only' }, { status: 409 })
        }
      } else if (resource === 'schedules') {
        // POST allowlists the scheduler action; PATCH must enforce the same
        // contract instead of storing an unknown action that silently degrades
        // to draft behaviour (auto-submit never fires).
        if (
          body.action !== undefined &&
          body.action !== 'submit_for_approval' &&
          body.action !== 'create_draft'
        ) {
          return NextResponse.json({ error: 'action must be submit_for_approval or create_draft' }, { status: 400 })
        }
        const current = (await db.execute<{ cron: string; timezone: string }>(sql`select cron, timezone from payment_schedules where id = ${id} and org_id = ${gate.user.orgId}`))
        if (!current.rows[0]) return notFound("record")
        const next = body.cron || body.timezone ? computeNextRunAt(body.cron?.trim() || current.rows[0].cron, new Date(), body.timezone?.trim() || current.rows[0].timezone) : undefined
        if ((body.cron || body.timezone) && !next) return NextResponse.json({ error: 'cron expression or time zone is invalid' }, { status: 400 })
        if (body.paymentBankProfileId) {
          const profile = (await db.execute(sql`select 1 from payment_bank_profiles p join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id where p.id = ${body.paymentBankProfileId} and p.org_id = ${gate.user.orgId} and p.is_active and f.direction <> 'debit'`))
          if (!profile.rows[0]) return NextResponse.json({ error: 'payment profile is invalid or inactive' }, { status: 400 })
        }
        // A write that matches zero rows is a failure, not a success: the row
        // may be missing or belong to another org (or have vanished between the
        // pre-read above and this transaction), and answering {ok:true} would
        // report a no-op as a save.
        const scheduleWrite = await db.transaction(async (tx) => {
          const before = (await tx.execute<Record<string, unknown>>(sql`
            select * from payment_schedules where id = ${id} and org_id = ${gate.user.orgId}
          `))
          if (!before.rows[0]) return 'missing' as const
          const updated = (await tx.execute<Record<string, unknown>>(sql`
            update payment_schedules set
              name = coalesce(${body.name?.trim() ?? null}, name),
              payment_bank_profile_id = coalesce(${body.paymentBankProfileId ?? null}::uuid, payment_bank_profile_id),
              cron = coalesce(${body.cron?.trim() ?? null}, cron),
              timezone = coalesce(${body.timezone?.trim() ?? null}, timezone),
              selection_criteria = coalesce(${body.selectionCriteria ? JSON.stringify(body.selectionCriteria) : null}::jsonb, selection_criteria),
              action = coalesce(${body.action ?? null}, action),
              next_run_at = coalesce(${next ?? null}, next_run_at),
              is_active = coalesce(${body.isActive ?? null}, is_active), updated_at = now(), updated_by = ${gate.user.id}
            where id = ${id} and org_id = ${gate.user.orgId}
            returning *
          `))
          if (!updated.rows[0]) return 'missing' as const
          await auditConfigChange(tx, gate.user.orgId, 'payment_schedules', id, 'update',
            { before: before.rows[0], after: updated.rows[0] }, gate.user.id, request.headers.get('X-Request-Id'))
          return 'updated' as const
        })
        if (scheduleWrite === 'missing') return notFound("record")
      } else {
        // POST allowlists the mandate status; PATCH must enforce the same
        // contract instead of storing an unknown status that silently disables
        // direct-debit collection (only 'active' mandates join payment runs).
        if (
          body.status !== undefined &&
          !['pending', 'active', 'suspended', 'revoked', 'expired'].includes(body.status)
        ) {
          return NextResponse.json({ error: 'status must be pending, active, suspended, revoked, or expired' }, { status: 400 })
        }
        // These cast straight to date: a non-calendar day would otherwise die
        // in Postgres with a raw driver failure, so require real calendar
        // dates before any write. Empty clears the date, like the update below.
        for (const [field, label] of [
          ['signedOn', 'signed date'],
          ['validFrom', 'valid-from date'],
          ['expiresOn', 'expiry date'],
        ] as const) {
          const value = body[field]
          if (value !== undefined && value !== null && value !== '' && !isIsoCalendarDate(value)) {
            return NextResponse.json({ error: `${label} must be a real calendar date (YYYY-MM-DD)` }, { status: 400 })
          }
        }
        // A write that matches zero rows is a failure, not a success: a missing
        // or other-org id must answer 404, never {ok:true} for work no read can
        // observe.
        const mandateWrite = await db.transaction(async (tx) => {
          const candidate = (await tx.execute<{ party_id: string }>(sql`
            select party_id from payment_mandates where id = ${id} and org_id = ${gate.user.orgId}
          `)).rows[0]
          if (!candidate) return 'missing' as const
          // Mandates follow their counterparty's legal-entity ownership. Lock
          // the party before the mandate, matching party rehome lock order.
          const party = (await tx.execute(sql`
            select p.id from parties p
             where p.id = ${candidate.party_id} and p.org_id = ${gate.user.orgId} and p.is_active
               ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
             for update
          `)).rows[0]
          if (!party) return 'missing' as const
          const before = (await tx.execute<Record<string, unknown>>(sql`
            select * from payment_mandates where id = ${id} and org_id = ${gate.user.orgId} for update
          `)).rows[0]
          if (!before || before.party_id !== candidate.party_id) return 'missing' as const
          const updated = (await tx.execute<Record<string, unknown>>(sql`
            update payment_mandates set
              status = coalesce(${body.status ?? null}, status),
              signed_on = case when ${body.signedOn === undefined} then signed_on else ${body.signedOn || null}::date end,
              valid_from = case when ${body.validFrom === undefined} then valid_from else ${body.validFrom || null}::date end,
              expires_on = case when ${body.expiresOn === undefined} then expires_on else ${body.expiresOn || null}::date end,
              updated_at = now(), updated_by = ${gate.user.id}
            where id = ${id} and org_id = ${gate.user.orgId}
            returning *
          `))
          if (!updated.rows[0]) return 'missing' as const
          await auditConfigChange(tx, gate.user.orgId, 'payment_mandates', id, 'update',
            { before, after: updated.rows[0] }, gate.user.id, request.headers.get('X-Request-Id'))
          return 'updated' as const
        })
        if (mandateWrite === 'missing') return notFound("record")
      }
      return NextResponse.json({ ok: true })
    } catch (error) {
      // ScopeNotFoundError carries status 404, so the shared boundary preserves
      // this route's uniform 404 for hidden parties.
      return apiErrorResponse(error)
    }
  },
});
