import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { ControlAccountsIncompleteError } from '@openbooks/engine/src/records/control-accounts.ts'
import { can } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import {
  createProjectCharge,
  chargeCommittedDetails,
  ChargeCommittedError,
  ChargeError,
  ChargeNotFoundError,
  type ChargeLineInput,
} from '../../../lib/project-charges'
import { postPermission } from '../../../lib/document-kinds'
import { canonicalDecimal, compareDecimal } from '../../../lib/exact-decimal'
import { moneyRefusal } from '../../../lib/payroll-decimal-refusal'
import { isFeatureEnabled } from '../../../lib/features'
import { guardProjectsFeature } from '../../../lib/projects-gate'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])
const rateComponentSchema = z.object({
  rateLineId: z.string().uuid().nullable(),
  unitCode: z.string(),
  unitName: z.string(),
  quantity: z.string(),
  rate: z.string(),
  amount: z.string(),
  quantityRatio: z.object({ numerator: z.string(), denominator: z.string() }).optional(),
}).strict()
const ratePriceSchema = z.object({ amount: z.string(), components: z.array(rateComponentSchema) }).strict()
const chargeLineSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.string().min(1),
  equipmentUnitId: z.string().uuid().nullable().optional(),
  employeeId: z.string().uuid().nullable().optional(),
  costRate: z.string().nullable().optional(),
  billRate: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  isBillable: z.boolean().optional(),
  rateSnapshot: z.object({
    rateVersionId: z.string().uuid().nullable(),
    baseUnit: z.string(),
    baseQuantity: z.string().optional(),
    transactionUnitCode: z.string().nullable().optional(),
    invoicePresentation: z.enum(['summary', 'rate_components']),
    cost: ratePriceSchema,
    bill: ratePriceSchema,
  }).strict().nullable().optional(),
}).strict()
const projectChargeBody = z.object({
  projectId: z.string().uuid(),
  referenceNumber: z.string().nullable().optional(),
  lines: z.array(chargeLineSchema).min(1),
}).strict()

/** Whole-digit width of a canonical decimal. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

function moneyOrNull(v: unknown): string | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null
  const exact = canonicalDecimal(v, 4)
  if (exact === null) return 'invalid'
  // Every charge-line figure lands in a numeric(19,4) column — rates and
  // amounts directly, and the quantity again through base_quantity, the
  // derived amounts, and the rate components — so magnitudes wider than 15
  // whole digits would die in Postgres as a raw overflow (HTTP 500).
  if (wholeDigits(exact) > 15) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

function quantityOrInvalid(v: unknown): string | 'invalid' {
  const exact = canonicalDecimal(v, 8)
  if (exact === null || compareDecimal(exact, '0') <= 0) return 'invalid'
  if (wholeDigits(exact) > 15) return 'invalid'
  return exact
}

/** GET ?projectId= — list project_charge documents (+ their billed status). */
export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projects',
  handler: async ({ request: req, authz: gate }) => {
  const projectId = new URL(req.url).searchParams.get('projectId')
  if (!projectId || !isUuid(projectId)) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  const project = ((await db.execute(sql`select subsidiary_id from projects where id = ${projectId} and org_id = ${gate.user.orgId}`)))
  if (!project.rows[0] || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(project.rows[0].subsidiary_id)))) {
    return notFound("record")
  }
  const r = (await db.execute(sql`
    select d.id, d.document_number as "documentNumber", d.document_date as "documentDate", d.status,
           d.total::numeric(19,4) as cost,
           coalesce(sum(coalesce(dl.bill_amount, dl.amount * coalesce(nullif(dl.cost_multiplier,0),1))) filter (where dl.is_billable), 0)::numeric(19,4) as "billValue",
           count(dl.*) as lines,
           bool_and(dl.billed_by_line_id is not null) filter (where dl.is_billable) as billed
      from documents d
      left join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
     where d.org_id = ${gate.user.orgId} and d.kind = 'project_charge' and d.project_id = ${projectId}
     group by d.id
     order by d.document_date desc, d.document_number desc
  `))
  return NextResponse.json({ charges: r.rows })
  },
})

/** POST — create + post a project charge. */
export const POST = defineRoute({
  permission: 'projects.manage',
  feature: 'projects',
  handler: async ({ request: req, authz: gate }) => {
  const parsedBody = await parseJsonBody(req, projectChargeBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { projectId: string; referenceNumber?: string | null; lines: ChargeLineInput[] }
  const project = ((await db.execute(sql`select subsidiary_id from projects where id = ${body.projectId} and org_id = ${gate.user.orgId}`)))
  if (!project.rows[0] || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(project.rows[0].subsidiary_id)))) {
    return notFound("record")
  }
  const lines: ChargeLineInput[] = []
  for (const line of body.lines) {
    const quantity = quantityOrInvalid(line.quantity)
    if (quantity === 'invalid') {
      return NextResponse.json({ error: 'Charge quantity must be a positive exact decimal' }, { status: 422 })
    }
    const costRate = moneyOrNull(line.costRate)
    if (costRate === 'invalid') {
      return NextResponse.json({ error: moneyRefusal('Cost rate', line.costRate, 'a rate') }, { status: 422 })
    }
    const billRate = moneyOrNull(line.billRate)
    if (billRate === 'invalid') {
      return NextResponse.json({ error: moneyRefusal('Bill rate', line.billRate, 'a rate') }, { status: 422 })
    }
    lines.push({ ...line, quantity, costRate, billRate })
  }
  if (lines.some((line) => line.equipmentUnitId) && !(await isFeatureEnabled(gate.user.orgId, 'equipment'))) {
    return notFound("record")
  }
  if (!(await isFeatureEnabled(gate.user.orgId, 'inventory'))) {
    for (const line of lines) {
      if (!isUuid(String(line.itemId ?? ''))) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${gate.user.orgId}`))
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        return notFound("record")
      }
    }
  }
  if (!(await isFeatureEnabled(gate.user.orgId, 'equipment'))) {
    for (const line of lines) {
      if (!isUuid(String(line.itemId ?? ''))) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${gate.user.orgId}`))
      if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
        return notFound("record")
      }
    }
  }
  try {
    // project_charge is a GL-family direct-post kind (DR project COGS / CR
    // cost pool). Originating the charge takes projects.manage, but posting
    // it takes the kind's postPermission — the same map the generic document
    // actions route enforces — so a projects.manage-only role can never post
    // to the GL here. Without it the charge is saved as a draft carrying the
    // named refusal; a gl.post holder posts it through the generic actions.
    const postPerm = postPermission('project_charge')
    const mayPost = can(gate, postPerm)
    const created = await createProjectCharge(gate.user.orgId, gate.user.id, {
      projectId: body.projectId,
      referenceNumber: body.referenceNumber ?? null,
      lines,
    }, { post: mayPost, allowedSubsidiaryIds: gate.allowedSubsidiaryIds })
    if (mayPost) return NextResponse.json(created)
    return NextResponse.json({
      ...created,
      posted: false,
      postRefusal: `missing permission: ${postPerm} — the charge was saved as a draft; posting needs ${postPerm}`,
    })
  } catch (e) {
    // The in-transaction scope recheck refuses exactly like the pre-read
    // above (a concurrent rehome moved the project after it), never a 422.
    if (e instanceof ChargeNotFoundError) {
      return notFound("record")
    }
    // Creation commits before approval/posting so a lifecycle failure must
    // identify the durable charge instead of inviting a duplicate retry.
    if (e instanceof ChargeCommittedError) {
      // The committed identity rides along so the caller repairs the exact
      // charge instead of retrying creation (pinned by the route test).
      return apiErrorResponse(e, { safeStatus: 409, details: chargeCommittedDetails(e) })
    }
    // Posting refusals (kernel rules or unconfigured org control accounts) are
    // request-state failures, not server defects.
    if (e instanceof ChargeError || e instanceof ControlAccountsIncompleteError) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
    return apiErrorResponse(e)
  }
  },
})
