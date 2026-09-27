import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'

import { NextResponse } from 'next/server'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  assertValidProjectFinancialProfile,
  canonicalizeProjectFinancialProfile,
  publishProjectFinancialProfileInTransaction,
} from '@openbooks/engine/src/projects/financial-profile-versions.ts'
import type { FinancialProfile } from '@openbooks/schema'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { guardPermission, guardUnrestrictedScope } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'
import { isFeatureEnabled } from '../../../../../lib/features'
import { notFound } from "@/lib/api/responses";
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { moneyRefusal } from '../../../../../lib/payroll-decimal-refusal'

const invoicingProfileSchema = z.object({
  billingProcedure: z.enum(["standard", "application_for_payment"]),
  allowedBases: z.array(z.string().min(1)).min(1), defaultBasis: z.string().min(1),
  lineBuilder: z.enum(["tm_actual", "milestone", "draw", "cost_plus"]),
  revenueAccount: z.enum(["item_income", "unbilled_receivable", "fixed"]),
  itemCategories: z.array(z.string()).optional(), itemKinds: z.array(z.string()).optional(), sourceKinds: z.array(z.string()).optional(),
});
const backupProfileSchema = z.object({ required: z.boolean(), defaultBackupType: z.string().min(1), allowedBackupTypes: z.array(z.string().min(1)).min(1) });
const financialProfileSchema = z.json().superRefine((value, ctx) => {
  try { assertValidProjectFinancialProfile(value); } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid financial profile" });
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const checkAmount = (field: string, raw: unknown) => {
    if (raw !== undefined && (typeof raw !== "string" || canonicalDecimal(raw, 4) === null)) {
      ctx.addIssue({ code: "custom", message: moneyRefusal(field, raw, "an exact decimal amount", 4) });
    }
  };
  const overhead = record.overhead;
  if (overhead && typeof overhead === "object" && !Array.isArray(overhead)) {
    const item = overhead as Record<string, unknown>;
    checkAmount("overhead.ratePercent", item.ratePercent);
    checkAmount("overhead.ratePerHour", item.ratePerHour);
  }
  const totalPrice = record.totalPrice;
  if (totalPrice && typeof totalPrice === "object" && !Array.isArray(totalPrice)) {
    checkAmount("totalPrice.defaultMarkupPercent", (totalPrice as Record<string, unknown>).defaultMarkupPercent);
  }
});
const createBodySchema = z.object({
  key: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(200),
  billingMethod: z.enum(["time_and_materials", "fixed_price", "cost_plus"]),
  financialProfile: financialProfileSchema, invoicingProfile: invoicingProfileSchema, backupProfile: backupProfileSchema,
  description: z.string().nullable().optional(), sortOrder: z.number().int().optional(),
});
const updateBodySchema = z.object({
  id: z.string().uuid(), billingMethod: z.enum(["time_and_materials", "fixed_price", "cost_plus"]),
  name: z.string().trim().min(1).max(200).optional(), description: z.string().nullable().optional(),
  isActive: z.boolean().optional(), sortOrder: z.number().int().optional(),
  financialProfile: financialProfileSchema.optional(), financialEffectiveFrom: z.iso.date({ error: "financialEffectiveFrom must be a real calendar date in YYYY-MM-DD format" }).optional(),
  financialChangeReason: z.string().trim().max(500).optional(),
  invoicingProfile: invoicingProfileSchema.optional(), backupProfile: backupProfileSchema.optional(),
});


export const runtime = 'nodejs'

/** Sort order rides into an integer column: refuse what Number() would turn
 * into NaN or a fractional/out-of-range value before any read or write. */
function invalidSortOrder(value: unknown): boolean {
  return typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647
}

function isProfileRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateInvoicingProfile(profile: unknown, billingMethod: unknown): string | null {
  const validBases = new Set(['date_range', 'draw_amount', 'time_selection', 'milestone', 'field_ticket'])
  const record = isProfileRecord(profile) ? profile : {}
  const procedure = record.billingProcedure
  if (typeof procedure !== 'string' || !['standard', 'application_for_payment'].includes(procedure)) return 'Invalid billing procedure'
  if (!Array.isArray(record.allowedBases) || record.allowedBases.length === 0) return 'At least one billing basis is required'
  if (record.allowedBases.some((basis: unknown) => typeof basis !== 'string' || !validBases.has(basis))) {
    return 'Invalid billing basis'
  }
  if (new Set(record.allowedBases).size !== record.allowedBases.length) return 'Billing bases must be unique'
  if (!record.allowedBases.includes(record.defaultBasis)) return 'Default billing basis must be allowed'
  if (procedure === 'application_for_payment') {
    if (billingMethod !== 'fixed_price') return 'Applications for payment require the fixed-price billing classification'
    if (record.allowedBases.length !== 1 || record.allowedBases[0] !== 'draw_amount') {
      return 'Applications for payment require draw-amount billing'
    }
    if (record.defaultBasis !== 'draw_amount' || record.lineBuilder !== 'draw') {
      return 'Applications for payment require the controlled draw line builder'
    }
  }
  return null
}

/** Create / update / archive a project type. Financial policy is published as
 * an append-only effective-dated version; the other profiles remain ordinary
 * audited setup because they do not reinterpret historical profitability. */




async function legacyDELETE(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardUnrestrictedScope(gate)
  if (scopeDenied) return scopeDenied
  const orgId = gate.user.orgId
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id || !isUuid(id)) return notFound("record")
  // Once a financial policy exists the project type is accounting configuration.
  // Archive it; do not erase the type or its policy history even if unused.
  const result = await db.transaction(async (tx) => {
    const before = (await tx.execute<Record<string, unknown>>(sql`
      select * from project_types where id = ${id} and org_id = ${orgId} for update
    `))
    if (!before.rows[0]) return null
    await tx.execute(sql`update project_types set is_active = false, updated_at = now(), updated_by = ${gate.user.id} where id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'project_types', ${id}, 'archive',
              ${JSON.stringify({ before: before.rows[0] })}, ${gate.user.id})`)
    return true
  })
  if (result === null) return notFound("record")
  return NextResponse.json({ ok: true, archived: true })
}

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  body: createBodySchema,
  handler: async ({ authz: routeAuthz }) => {

    const gate = routeAuthz



    const orgId = gate.user.orgId
    const feature = await guardProjectsFeature(orgId)
    if (feature) return feature



    const key = String(b.key ?? '').trim()
    const name = String(b.name ?? '').trim()
    if (!key || !name) return NextResponse.json({ error: 'Key and name are required' }, { status: 422 })
    if (typeof b.billingMethod !== 'string' || !['time_and_materials', 'fixed_price', 'cost_plus'].includes(b.billingMethod))
      return NextResponse.json({ error: 'Billing classification is required' }, { status: 422 })
    if (!b.financialProfile || !b.invoicingProfile || !b.backupProfile)
      return NextResponse.json({ error: 'Missing profile' }, { status: 422 })
    const profileError = validateInvoicingProfile(b.invoicingProfile, b.billingMethod)
    if (profileError) return NextResponse.json({ error: profileError }, { status: 422 })
    // Validation above establishes the invoicing shape; only the static view
    // is pinned down here.
    const invoicingBases = (b.invoicingProfile as { allowedBases: string[] }).allowedBases
    if (b.sortOrder !== undefined && b.sortOrder !== null && invalidSortOrder(b.sortOrder))
      return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 })
    if (
      invoicingBases.includes('field_ticket')
      && !(await isFeatureEnabled(orgId, 'fieldTickets'))
    ) {
      return NextResponse.json(
        { error: 'Enable Field Tickets in Company Settings → Features before adding Field Ticket billing' },
        { status: 422 },
      )
    }
    try {
      const id = await db.transaction(async (tx) => {
        const r = (await tx.execute<{ id: string }>(sql`
          insert into project_types (org_id, key, name, description, is_built_in, is_active, sort_order,
            billing_method, invoicing_profile, backup_profile, created_by, updated_by)
          values (${orgId}, ${key}, ${name}, ${b.description ?? null}, false, true, ${Number(b.sortOrder ?? 50)},
            ${b.billingMethod}, ${JSON.stringify(b.invoicingProfile)}::jsonb,
            ${JSON.stringify(b.backupProfile)}::jsonb,
            ${gate.user.id}, ${gate.user.id})
          returning id`))
        const createdId = r.rows[0]!.id
        await publishProjectFinancialProfileInTransaction(tx, {
          orgId,
          projectTypeId: createdId,
          effectiveFrom: await businessToday(orgId),
          // The engine asserts validity on publish; failures 422 below.
          financialProfile: b.financialProfile as unknown as FinancialProfile,
          reason: 'Initial project type financial policy',
          actorId: gate.user.id,
        })
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'project_types', ${createdId}, 'insert',
                  ${JSON.stringify({ after: { key, name, billingMethod: b.billingMethod, financialProfile: b.financialProfile, invoicingProfile: b.invoicingProfile, backupProfile: b.backupProfile } })},
                  ${gate.user.id})`)
        return createdId
      })
      return NextResponse.json({ id })
    } catch (e) {
      const msg = (e as Error).message
      if (/unique|duplicate/i.test(msg)) return NextResponse.json({ error: 'A type with that key already exists' }, { status: 409 })
      return NextResponse.json({ error: msg }, { status: 422 })
    }
  },
});

export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  body: updateBodySchema,
  handler: async ({ authz: routeAuthz }) => {

    const gate = routeAuthz



    const orgId = gate.user.orgId
    const today = await businessToday(orgId)
    const feature = await guardProjectsFeature(orgId)
    if (feature) return feature



    if (b.financialProfile) {
      try {
        assertValidProjectFinancialProfile(b.financialProfile)
      } catch (error) {
        return apiErrorResponse(error)
      }
    }
    if (typeof b.id !== 'string' || !isUuid(b.id)) return notFound("record")
    const id = b.id
    if (typeof b.billingMethod !== 'string' || !['time_and_materials', 'fixed_price', 'cost_plus'].includes(b.billingMethod))
      return NextResponse.json({ error: 'Billing classification is required' }, { status: 422 })
    const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(b, key)
    if (hasOwn('name') && !String(b.name ?? '').trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 422 })
    }
    if (b.invoicingProfile) {
      const profileError = validateInvoicingProfile(b.invoicingProfile, b.billingMethod)
      if (profileError) return NextResponse.json({ error: profileError }, { status: 422 })
    }
    const fieldTicketsEnabled = b.invoicingProfile
      ? await isFeatureEnabled(orgId, 'fieldTickets')
      : false
    if (hasOwn('isActive') && typeof b.isActive !== 'boolean')
      return NextResponse.json({ error: 'isActive must be a boolean' }, { status: 400 })
    if (hasOwn('sortOrder') && invalidSortOrder(b.sortOrder))
      return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 })
    const sets: SQL[] = []
    if (hasOwn('name')) sets.push(sql`name = ${String(b.name).trim()}`)
    if (hasOwn('description')) sets.push(sql`description = ${b.description ?? null}`)
    if (hasOwn('isActive')) sets.push(sql`is_active = ${b.isActive}`)
    if (hasOwn('sortOrder')) sets.push(sql`sort_order = ${b.sortOrder}`)
    sets.push(sql`billing_method = ${b.billingMethod}`, sql`updated_at = now()`, sql`updated_by = ${gate.user.id}`)
    if (b.invoicingProfile) sets.push(sql`invoicing_profile = ${JSON.stringify(b.invoicingProfile)}::jsonb`)
    if (b.backupProfile) sets.push(sql`backup_profile = ${JSON.stringify(b.backupProfile)}::jsonb`)
    let updated: boolean
    try {
      updated = await db.transaction(async (tx) => {
        const before = (await tx.execute<(Record<string, unknown> & { financial_profile: unknown })>(sql`
          select pt.key, pt.name, pt.description, pt.is_active, pt.sort_order,
                 pt.billing_method, pt.invoicing_profile, pt.backup_profile,
                 version.financial_profile as financial_profile
            from project_types pt
            left join lateral (
              select v.financial_profile
                from project_financial_profile_versions v
               where v.org_id = pt.org_id
                 and v.project_type_id = pt.id
                 and v.effective_from <= ${today}
                 and (v.effective_to is null or v.effective_to >= ${today})
               order by v.effective_from desc
               limit 1
            ) version on true
           where pt.id = ${b.id} and pt.org_id = ${orgId}
           for update of pt
        `))
        if (!before.rows[0]) return false
        const beforeInvoicing = before.rows[0].invoicing_profile as { allowedBases?: string[] } | null
        // Validation above establishes the invoicing shape when present.
        const invoicingBases = b.invoicingProfile
          ? (b.invoicingProfile as { allowedBases?: string[] }).allowedBases
          : undefined
        if (
          invoicingBases?.includes('field_ticket')
          && !fieldTicketsEnabled
          && !beforeInvoicing?.allowedBases?.includes('field_ticket')
        ) {
          throw new Error('Enable Field Tickets in Company Settings → Features before adding Field Ticket billing')
        }

        let financialVersion: { id: string; effectiveFrom: string; effectiveTo: string | null } | null = null
        if (b.financialProfile) {
          const comparison = (await tx.execute<{ changed: boolean }>(sql`
            select ${JSON.stringify(canonicalizeProjectFinancialProfile(b.financialProfile as unknown as FinancialProfile))}::jsonb
                   is distinct from
                   ${JSON.stringify(
                     before.rows[0].financial_profile
                       ? canonicalizeProjectFinancialProfile(
                           before.rows[0].financial_profile as unknown as FinancialProfile,
                         )
                       : null,
                   )}::jsonb as changed
          `))
          if (comparison.rows[0]?.changed) {
            financialVersion = await publishProjectFinancialProfileInTransaction(tx, {
              orgId,
              projectTypeId: id,
              effectiveFrom: String(b.financialEffectiveFrom ?? today),
              financialProfile: b.financialProfile as unknown as FinancialProfile,
              reason: String(b.financialChangeReason ?? ''),
              actorId: gate.user.id,
            })
          }
        }

        const after = (await tx.execute<Record<string, unknown>>(sql`
          update project_types set ${sql.join(sets, sql`, `)}
           where id = ${b.id} and org_id = ${orgId}
           returning key, name, description, is_active, sort_order, billing_method,
                     invoicing_profile, backup_profile
        `))
        const projectTypeBefore = { ...before.rows[0] }
        delete projectTypeBefore.financial_profile
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'project_types', ${b.id}, 'update',
                  ${JSON.stringify({
                    before: projectTypeBefore,
                    after: after.rows[0],
                    ...(financialVersion ? { financialProfileVersion: financialVersion } : {}),
                  })},
                  ${gate.user.id})`)
        return true
      })
    } catch (e) {
      return apiErrorResponse(e)
    }
    if (!updated) return notFound("record")
    return NextResponse.json({ ok: true })
  },
});

export const DELETE = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  handler: async ({ request }) => legacyDELETE(request as never),
});
