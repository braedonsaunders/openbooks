import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { saveBomPolicy, readBomPolicyVersion } from '@openbooks/engine/src/inventory/bom-policy.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { apiErrorResponse } from '@/lib/api/error-response'
import { can } from '@/lib/authz'
import { defineRoute } from '@/lib/api/route'
import { exactMoney, isoDate, uuidId } from '@/lib/api/json'
import { isFeatureEnabled } from '@/lib/features'
import { isUuid } from '@/lib/list-params'
import { z } from 'zod'

const optionalDate = z.union([isoDate(), z.literal(''), z.null()]).optional()
const optionalDecimal = z.union([exactMoney(), z.literal(''), z.null()]).optional()
const bomBody = z.object({
  assemblyItemId: uuidId,
  expectedVersion: z.string().nullable(),
  reason: z.string(),
  subsidiaryId: uuidId.optional(),
  components: z.array(z.object({
    componentItemId: uuidId, quantityPer: exactMoney(),quantityBasis:z.enum(['per_unit','per_batch','per_formula']).optional(),formulaOutputQuantity:exactMoney().optional(),
    effectiveFrom: optionalDate, effectiveTo: optionalDate,
    operationSeq: z.union([z.number(), z.string(), z.null()]).optional(),
    scrapPct: optionalDecimal,
    outputCostWeight:optionalDecimal,
    isByproduct: z.union([z.boolean(), z.enum(['true', 'false']), z.null()]).optional(),
  })),
})
function refusal(error: string, status = 422) { return NextResponse.json({error}, {status}) }

/** The native command owns validation, fresh authority, effectivity and approval. */
export const PUT = defineRoute({
  permission: 'admin.setup.manage', feature: 'inventory', scope: 'unrestricted', body: bomBody,
  handler: async ({body, request, authz: gate}) => {
    try {
      const result = await withOrgTransaction(gate.user.orgId, () => saveBomPolicy(db,gate.user.orgId,gate.user.id,{
        assemblyItemId:body.assemblyItemId,expectedVersion:body.expectedVersion,reason:body.reason,
        subsidiaryId:body.subsidiaryId,requestKey:request.headers.get('Idempotency-Key') ?? undefined,
        components:body.components.map(line=>({
          componentItemId:line.componentItemId,quantityPer:line.quantityPer,quantityBasis:line.quantityBasis,formulaOutputQuantity:line.formulaOutputQuantity,
          effectiveFrom:line.effectiveFrom || null,effectiveTo:line.effectiveTo || null,
          operationSeq:line.operationSeq === undefined || line.operationSeq === null || line.operationSeq === '' ? null : Number(line.operationSeq),
          scrapPct:line.scrapPct || null,isByproduct:line.isByproduct === true || line.isByproduct === 'true',outputCostWeight:line.outputCostWeight||null,
        })),
      }));
      return NextResponse.json(result);
    } catch(error) { return apiErrorResponse(error,{request}); }
  },
})

/**
 * Read one assembly's recipe for operators: the kit Components tab and the
 * bill-of-materials editor share this payload, so component lines carry
 * their catalog identity (code, name, active state) and the editor's
 * eligible choices ride along. Reading needs only the catalog grant — the
 * same grant as the kit availability endpoint beside it — because a
 * restricted operator may inspect a recipe they cannot change; replacing
 * the recipe stays an org-wide configuration write on PUT.
 */
export const GET = defineRoute({
  // Reading serves both grants: catalog readers inspect a recipe they
  // cannot change, and setup managers keep the access they already had.
  // The native helper names the primary grant on refusal.
  authorize: async () => {
    const { guardPermission } = await import('@/lib/authz');
    const catalog = await guardPermission('items.read');
    if (!(catalog instanceof NextResponse)) return catalog;
    const setup = await guardPermission('admin.setup.manage');
    if (!(setup instanceof NextResponse)) return setup;
    return catalog;
  },
  feature: 'inventory',
  handler: async ({ request, authz: gate }) => {
  const assemblyItemId = new URL(request.url).searchParams.get('assemblyItemId')
  const manufacturingEnabled = await isFeatureEnabled(gate.user.orgId, 'manufacturing')
  const today = await businessToday(gate.user.orgId)
  const canProposeRevision = gate.allowedSubsidiaryIds === null && can(gate,'manufacturing.manage') && can(gate,'admin.setup.manage')
  const subsidiaries = canProposeRevision ? (await db.execute<{id:string;name:string}>(sql`select id,name from subsidiaries where org_id=${gate.user.orgId} and is_active and not is_elimination order by name,id`)).rows : []
  if (!assemblyItemId) return NextResponse.json({ manufacturingEnabled,canProposeRevision,subsidiaries,today })
  if (!isUuid(assemblyItemId)) return refusal('Choose a valid assembly item.')

  const assembly = await db.execute<{ id: string; kind:string }>(sql`
    select id,kind from items where org_id = ${gate.user.orgId} and id = ${assemblyItemId}`)
  if (!assembly.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Catalog identity rides with every line: a component the picker would no
  // longer offer (inactive, unprofiled) still names itself instead of
  // falling back to its storage id. The joined row id tells readers
  // whether a catalog row stands behind the line: a null joined id means
  // no readable identity, and the line keeps its stored fields as evidence.
  // isCurrent applies the same half-open window the kit explosion and the
  // availability endpoint use, so the reader's current summary never
  // aggregates an expired window.
  const components = await db.execute<{
    id: string;
    componentItemId: string;
    quantityPer: string;quantityBasis:"per_unit"|"per_batch"|"per_formula";formulaOutputQuantity:string;
    sortOrder: number;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    operationSeq: number | null;
    scrapPct: string | null;
    isByproduct: boolean;
    outputCostWeight:string|null;
    code: string | null;
    name: string | null;
    isActive: boolean | null;
    joinedId: string | null;
    isCurrent: boolean;
  }>(sql`
    select line.id, line.component_item_id as "componentItemId", line.quantity_per::text as "quantityPer",line.quantity_basis as "quantityBasis",line.formula_output_quantity::text as "formulaOutputQuantity",
           line.sort_order as "sortOrder", line.effective_from::text as "effectiveFrom",
           line.effective_to::text as "effectiveTo", line.operation_seq as "operationSeq",
           line.scrap_pct::text as "scrapPct", line.is_byproduct as "isByproduct",line.output_cost_weight::text as "outputCostWeight",
           item.code, item.name, item.is_active as "isActive", item.id as "joinedId",
           ((line.effective_from is null or line.effective_from <= ${today}::date)
            and (line.effective_to is null or ${today}::date < line.effective_to)) as "isCurrent"
      from bom_components line
      left join items item on item.org_id = line.org_id and item.id = line.component_item_id
     where line.org_id = ${gate.user.orgId} and line.assembly_item_id = ${assemblyItemId}
     order by line.sort_order, line.component_item_id, line.operation_seq nulls first,
              line.is_byproduct, line.effective_from nulls first, line.effective_to nulls first`)
  const version = await readBomPolicyVersion(db,gate.user.orgId,assemblyItemId)
  // Editor choices mirror the set PUT accepts (active inventory items with
  // costing profiles), so the picker can only stage a recipe the save keeps.
  const validItems = await db.execute<{ id: string; code: string | null; name: string | null }>(sql`
    select item.id, item.code, item.name
      from items item
      join item_inventory_profiles profile
        on profile.org_id = item.org_id and profile.item_id = item.id
     where item.org_id = ${gate.user.orgId} and item.is_active
     order by item.code nulls last, item.name`)
  return NextResponse.json({
    manufacturingEnabled,
    assemblyItemId,
    kind:assembly.rows[0].kind,
    version,
    today,canProposeRevision,subsidiaries,
    components: components.rows.map((line) => ({
      ...line,
      operationSeq: manufacturingEnabled ? line.operationSeq : null,
      isByproduct: manufacturingEnabled ? line.isByproduct : false,
      outputCostWeight:manufacturingEnabled?line.outputCostWeight:null,
    })),
    validItems: validItems.rows,
  })
  },
})
