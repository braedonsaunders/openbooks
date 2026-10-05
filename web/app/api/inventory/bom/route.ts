import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { canonicalDecimal, compareDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { defineRoute } from '@/lib/api/route'
import { exactMoney, isoDate, uuidId } from '@/lib/api/json'
import { inventoryErrorStatus } from '@/lib/api/inventory-errors'
import { isFeatureEnabled } from '@/lib/features'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { isUuid } from '@/lib/list-params'
import { notFound } from "@/lib/api/responses";
import { z } from 'zod'

type ComponentInput = {
  componentItemId: string
  quantityPer: string
  sortOrder: number
  effectiveFrom: string | null
  effectiveTo: string | null
  operationSeq: number | null
  scrapPct: string | null
  isByproduct: boolean
}

const optionalDate = z.union([isoDate(), z.literal(''), z.null()]).optional()
const optionalDecimal = z.union([exactMoney(), z.literal(''), z.null()]).optional()
const bomBody = z.object({
  assemblyItemId: uuidId,
  expectedVersion: z.string().nullable(),
  reason: z.string(),
  components: z.array(z.object({
    componentItemId: uuidId,
    quantityPer: exactMoney(),
    effectiveFrom: optionalDate,
    effectiveTo: optionalDate,
    operationSeq: z.union([z.number(), z.string(), z.null()]).optional(),
    scrapPct: optionalDecimal,
    isByproduct: z.union([z.boolean(), z.enum(['true', 'false']), z.null()]).optional(),
  })),
})

function refusal(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string') return candidate.code
    current = candidate.cause
  }
  return undefined
}

function postgresErrorDetail(error: unknown): string {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { detail?: unknown; cause?: unknown }
    if (typeof candidate.detail === 'string') return candidate.detail
    current = candidate.cause
  }
  return ''
}

function overlappingWindows(components: ComponentInput[]) {
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      const a = components[left]!
      const b = components[right]!
      if (a.componentItemId !== b.componentItemId || a.operationSeq !== b.operationSeq || a.isByproduct !== b.isByproduct) continue
      const overlaps = (a.effectiveTo === null || b.effectiveFrom === null || a.effectiveTo > b.effectiveFrom)
        && (b.effectiveTo === null || a.effectiveFrom === null || b.effectiveTo > a.effectiveFrom)
      if (overlaps) return [a, b] as const
    }
  }
  return null
}

function overlapRefusal(pair: readonly [ComponentInput, ComponentInput]) {
  const window = (line: ComponentInput) => `[${line.effectiveFrom ?? 'unbounded start'}, ${line.effectiveTo ?? 'unbounded end'})`
  const componentItemId = pair[0].componentItemId
  const windows = [window(pair[0]), window(pair[1])]
  return NextResponse.json({
    error: `Component ${componentItemId} has overlapping effectivity windows ${windows[0]} and ${windows[1]}; adjust the dates so the same operation and by-product designation do not overlap.`,
    code: 'bom_effectivity_overlap',
    componentItemId,
    windows,
  }, { status: 422 })
}

/**
 * Replace one assembly's complete BOM as one controlled configuration write.
 * A table lock deliberately conflicts with buildAssembly's SHARE lock: a build
 * consumes either the entire prior recipe or the entire new recipe, never a
 * partially replaced component set. The authoritative Inventory feature is
 * re-checked inside the transaction (held to commit, so a disable racing the
 * save orders itself against it), and a per-assembly parent-row lock
 * serializes concurrent replacements (ROW EXCLUSIVE table locks do not
 * conflict with each other). The fence runs before the row lock — the same
 * orgs-then-subject order as item costing saves — so a BOM replacement and a
 * costing save on the same item cannot deadlock each other.
 */
export const PUT = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'inventory',
  scope: 'unrestricted',
  body: bomBody,
  handler: async ({ body, authz: gate }) => {
  // Bills of material are shared org-wide manufacturing policy.
  const assemblyItemId = body.assemblyItemId
  const expectedVersion = body.expectedVersion
  const reason = body.reason.trim()
  if (!isUuid(assemblyItemId)) return refusal('Choose a valid assembly item.')
  if (!reason) return refusal('Explain why this bill of materials is changing.')
  if (body.components.length === 0) {
    return refusal('A bill of materials requires at least one component line.')
  }
  if (body.components.length > 500) return refusal('A bill of materials cannot exceed 500 component lines.')

  const components: ComponentInput[] = []
  for (let index = 0; index < body.components.length; index += 1) {
    const row = body.components[index]!
    const componentItemId = row.componentItemId
    const quantityPer = canonicalDecimal(row.quantityPer, 4)
    if (!isUuid(componentItemId)) return refusal(`Choose a valid item on component line ${index + 1}.`)
    if (componentItemId === assemblyItemId) return refusal('An assembly cannot contain itself as a component.')
    if (quantityPer === null || compareDecimal(quantityPer, '0') <= 0) {
      return refusal(`Quantity per on component line ${index + 1} must be a positive decimal with at most 4 decimal places.`)
    }
    const dateValue = (value: unknown): string | null | undefined => {
      if (value === undefined || value === null || value === '') return null
      if (typeof value !== 'string' || !isIsoCalendarDate(value)) return undefined
      return value
    }
    const effectiveFrom = dateValue(row.effectiveFrom)
    const effectiveTo = dateValue(row.effectiveTo)
    if (effectiveFrom === undefined) return refusal(`Effective start on component line ${index + 1} must be a real YYYY-MM-DD calendar date.`)
    if (effectiveTo === undefined) return refusal(`Effective end on component line ${index + 1} must be a real YYYY-MM-DD calendar date.`)
    if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) {
      return refusal(`Effective end ${effectiveTo} on component line ${index + 1} must be after effective start ${effectiveFrom}.`)
    }
    const scrapRaw = row.scrapPct
    const scrapPct = scrapRaw === undefined || scrapRaw === null || scrapRaw === '' ? null : canonicalDecimal(scrapRaw, 4)
    if (scrapPct === null && scrapRaw !== undefined && scrapRaw !== null && scrapRaw !== '') {
      return refusal(`Scrap percentage on component line ${index + 1} must be an exact decimal with at most 4 decimal places.`)
    }
    if (scrapPct !== null && (compareDecimal(scrapPct, '0') < 0 || compareDecimal(scrapPct, '100') >= 0)) {
      return refusal(`Scrap percentage on component line ${index + 1} must be at least 0 and less than 100.`)
    }
    const operationRaw = row.operationSeq
    const operationDecimal = operationRaw === undefined || operationRaw === null || operationRaw === ''
      ? null
      : canonicalDecimal(typeof operationRaw === 'number' && Number.isSafeInteger(operationRaw) ? String(operationRaw) : operationRaw, 0)
    const operationSeq = operationDecimal === null ? null : Number(operationDecimal)
    if (operationRaw !== undefined && operationRaw !== null && operationRaw !== '' &&
        (operationDecimal === null || !Number.isSafeInteger(operationSeq) || operationSeq! <= 0 || operationSeq! > 2_147_483_647)) {
      return refusal(`Operation sequence on component line ${index + 1} must be a positive integer.`)
    }
    const byproductRaw = row.isByproduct
    const isByproduct = byproductRaw === undefined || byproductRaw === null || byproductRaw === false || byproductRaw === 'false'
      ? false
      : byproductRaw === true || byproductRaw === 'true'
    if (byproductRaw !== undefined && byproductRaw !== null && isByproduct === false && byproductRaw !== false && byproductRaw !== 'false') {
      return refusal(`By-product setting on component line ${index + 1} must be true or false.`)
    }
    components.push({
      componentItemId, quantityPer, sortOrder: index,
      effectiveFrom, effectiveTo, operationSeq, scrapPct, isByproduct,
    })
  }
  const overlapping = overlappingWindows(components)
  if (overlapping) return overlapRefusal(overlapping)

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`lock table bom_components in row exclusive mode`)
      // Fence the authoritative feature inside the transaction: a disable
      // that commits between the route gate and this read refuses here with
      // no recipe or audit written. The FOR SHARE row lock is held to commit,
      // so a concurrent disable orders itself against this save either way.
      if (!(await lockAndCheckOrgFeature(tx, gate.user.orgId, 'inventory'))) {
        return { featureDisabled: true as const }
      }
      const manufacturingEnabled = await lockAndCheckOrgFeature(tx, gate.user.orgId, 'manufacturing')
      if (!manufacturingEnabled && components.some((line) => line.operationSeq !== null || line.isByproduct)) {
        return { featureDisabled: true as const }
      }
      // Serialize concurrent replacements on the parent item row. Two PUTs on
      // an empty BOM would otherwise both read version null and their inserts
      // would union into a recipe nobody wrote; the loser instead re-reads
      // the winner's committed version below and takes the 409 path. NO KEY
      // UPDATE stays compatible with the foreign-key checks on the inserts
      // (same pattern as item costing saves, fence first and row lock second).
      // A missing parent row locks nothing — the active-inventory check below
      // still refuses it.
      await tx.execute(sql`
        select id from items
         where id = ${assemblyItemId} and org_id = ${gate.user.orgId}
         for no key update`)
      // Kits ship exactly the quantities named: manufacturing recipe
      // features (operations, by-products, scrap) have no meaning for a
      // virtual bundle and every engine reader excludes them.
      const parent = (await tx.execute<{ kind: string }>(sql`
        select kind from items
         where id = ${assemblyItemId} and org_id = ${gate.user.orgId}`)).rows[0]
      if (parent?.kind === 'kit' && components.some((line) =>
        line.operationSeq !== null || line.isByproduct ||
        (line.scrapPct !== null && compareDecimal(line.scrapPct, '0') !== 0))) {
        return { kitManufacturing: true as const }
      }

      const versionResult = await tx.execute<{ version: string | null }>(sql`
        select md5(string_agg(
          id::text || ':' || updated_at::text || ':' || component_item_id::text || ':' ||
          quantity_per::text || ':' || sort_order::text || ':' ||
          coalesce(effective_from::text, '') || ':' || coalesce(effective_to::text, '') || ':' ||
          coalesce(operation_seq::text, '') || ':' || coalesce(scrap_pct::text, '') || ':' || is_byproduct::text,
          ',' order by sort_order, component_item_id, operation_seq nulls first,
                   is_byproduct, effective_from nulls first, effective_to nulls first
        )) as version
          from bom_components
         where org_id = ${gate.user.orgId} and assembly_item_id = ${assemblyItemId}`)
      const currentVersion = versionResult.rows[0]?.version ?? null
      if (currentVersion !== expectedVersion) {
        return { conflict: true as const }
      }

      const beforeResult = await tx.execute<{
        id: string
        componentItemId: string
        quantityPer: string
        sortOrder: number
        effectiveFrom: string | null
        effectiveTo: string | null
        operationSeq: number | null
        scrapPct: string | null
        isByproduct: boolean
      }>(sql`
        select id, component_item_id as "componentItemId",
               quantity_per::text as "quantityPer", sort_order as "sortOrder",
               effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
               operation_seq as "operationSeq", scrap_pct::text as "scrapPct", is_byproduct as "isByproduct"
          from bom_components
         where org_id = ${gate.user.orgId} and assembly_item_id = ${assemblyItemId}
         order by sort_order, component_item_id, operation_seq nulls first,
                  is_byproduct, effective_from nulls first, effective_to nulls first`)
      if (!manufacturingEnabled && beforeResult.rows.some((line) => line.operationSeq !== null || line.isByproduct)) {
        return { featureDisabled: true as const }
      }

      const itemIds = [...new Set([assemblyItemId, ...components.map((line) => line.componentItemId)])]
      const validItems = await tx.execute<{ id: string }>(sql`
        select distinct item.id
          from items item
          join item_inventory_profiles profile
            on profile.org_id = item.org_id and profile.item_id = item.id
         where item.org_id = ${gate.user.orgId}
           and item.is_active
           and item.id in (${sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
      if (validItems.rows.length !== itemIds.length) {
        return { invalidItems: true as const }
      }

      if (beforeResult.rows.length > 0) {
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from bom_components
           where org_id = ${gate.user.orgId} and assembly_item_id = ${assemblyItemId}
          returning id`)
        if (deleted.rows.length !== beforeResult.rows.length) {
          throw new Error('bill of materials replacement refused: not every prior component row was removed')
        }
      }

      for (const component of components) {
        const inserted = await tx.execute<{ id: string }>(sql`
        insert into bom_components (
            org_id, assembly_item_id, component_item_id, quantity_per, sort_order,
            effective_from, effective_to, operation_seq, scrap_pct, is_byproduct,
            created_by, updated_by
          ) values (
            ${gate.user.orgId}, ${assemblyItemId}, ${component.componentItemId},
            ${component.quantityPer}, ${component.sortOrder},
            ${component.effectiveFrom}, ${component.effectiveTo}, ${component.operationSeq},
            ${component.scrapPct}, ${component.isByproduct}, ${gate.user.id}, ${gate.user.id}
          )
          returning id`)
        if (inserted.rows.length !== 1) {
          throw new Error(`bill of materials replacement refused: component ${component.componentItemId} was not stored`)
        }
      }

      const audited = await tx.execute<{ id: string }>(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (
          ${gate.user.orgId}, 'bom_components', ${assemblyItemId},
          ${beforeResult.rows.length === 0 ? 'insert' : 'update'},
          ${JSON.stringify({
            reason,
            before: beforeResult.rows,
            after: components,
          })}::jsonb,
          ${gate.user.id}
        )
        returning id`)
      if (audited.rows.length !== 1) {
        throw new Error('bill of materials replacement refused: its audit record was not stored')
      }

      const nextVersionResult = await tx.execute<{ version: string | null }>(sql`
        select md5(string_agg(
          id::text || ':' || updated_at::text || ':' || component_item_id::text || ':' ||
          quantity_per::text || ':' || sort_order::text || ':' ||
          coalesce(effective_from::text, '') || ':' || coalesce(effective_to::text, '') || ':' ||
          coalesce(operation_seq::text, '') || ':' || coalesce(scrap_pct::text, '') || ':' || is_byproduct::text,
          ',' order by sort_order, component_item_id, operation_seq nulls first,
                   is_byproduct, effective_from nulls first, effective_to nulls first
        )) as version
          from bom_components
         where org_id = ${gate.user.orgId} and assembly_item_id = ${assemblyItemId}`)
      return {
        version: nextVersionResult.rows[0]?.version ?? null,
        componentCount: components.length,
      }
    })

    if ('conflict' in result) {
      return refusal('This bill of materials changed after you opened it. Close the drawer, reopen it, and apply your changes to the latest revision.', 409)
    }
    if ('featureDisabled' in result) {
      return notFound("record")
    }
    if ('invalidItems' in result) {
      return refusal('Every assembly and component must be an active inventory item in this organization.')
    }
    if ('kitManufacturing' in result) {
      return refusal('A kit ships exactly the quantities named: remove the operation, by-product or scrap rate from its recipe.')
    }
    return NextResponse.json(result)
  } catch (error) {
    if (postgresErrorCode(error) === '23P01') {
      const pair = overlappingWindows(components)
      if (pair) return overlapRefusal(pair)
      const detail = postgresErrorDetail(error)
      const component = components.find((line) => detail.includes(line.componentItemId)) ?? components[0]!
      const ranges = [...detail.matchAll(/\[(\d{4}-\d{2}-\d{2})?,(\d{4}-\d{2}-\d{2})?\)/g)]
        .map((match) => `[${match[1] || 'unbounded start'}, ${match[2] || 'unbounded end'})`)
      const dates = ranges.length ? ranges.join(' and ') : `[${component.effectiveFrom ?? 'unbounded start'}, ${component.effectiveTo ?? 'unbounded end'})`
      return NextResponse.json({
        error: `Component ${component.componentItemId} has overlapping effectivity dates ${dates}; adjust the dates so the same operation and by-product designation do not overlap.`,
        code: 'bom_effectivity_overlap',
        componentItemId: component.componentItemId,
        windows: ranges,
      }, { status: 422 })
    }
    const message = error instanceof Error ? error.message : 'Bill of materials save failed.'
    return refusal(message, inventoryErrorStatus(error))
  }
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
  if (!assemblyItemId) return NextResponse.json({ manufacturingEnabled })
  if (!isUuid(assemblyItemId)) return refusal('Choose a valid assembly item.')

  const assembly = await db.execute<{ id: string }>(sql`
    select id from items where org_id = ${gate.user.orgId} and id = ${assemblyItemId}`)
  if (!assembly.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Catalog identity rides with every line: a component the picker would no
  // longer offer (inactive, unprofiled) still names itself instead of
  // falling back to its storage id. The joined row id tells readers
  // whether a catalog row stands behind the line: a null joined id means
  // no readable identity, and the line keeps its stored fields as evidence.
  const components = await db.execute<{
    id: string;
    componentItemId: string;
    quantityPer: string;
    sortOrder: number;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    operationSeq: number | null;
    scrapPct: string | null;
    isByproduct: boolean;
    code: string | null;
    name: string | null;
    isActive: boolean | null;
    joinedId: string | null;
  }>(sql`
    select line.id, line.component_item_id as "componentItemId", line.quantity_per::text as "quantityPer",
           line.sort_order as "sortOrder", line.effective_from::text as "effectiveFrom",
           line.effective_to::text as "effectiveTo", line.operation_seq as "operationSeq",
           line.scrap_pct::text as "scrapPct", line.is_byproduct as "isByproduct",
           item.code, item.name, item.is_active as "isActive", item.id as "joinedId"
      from bom_components line
      left join items item on item.org_id = line.org_id and item.id = line.component_item_id
     where line.org_id = ${gate.user.orgId} and line.assembly_item_id = ${assemblyItemId}
     order by line.sort_order, line.component_item_id, line.operation_seq nulls first,
              line.is_byproduct, line.effective_from nulls first, line.effective_to nulls first`)
  const version = await db.execute<{ version: string | null }>(sql`
    select md5(string_agg(
      id::text || ':' || updated_at::text || ':' || component_item_id::text || ':' ||
      quantity_per::text || ':' || sort_order::text || ':' ||
      coalesce(effective_from::text, '') || ':' || coalesce(effective_to::text, '') || ':' ||
      coalesce(operation_seq::text, '') || ':' || coalesce(scrap_pct::text, '') || ':' || is_byproduct::text,
      ',' order by sort_order, component_item_id, operation_seq nulls first,
               is_byproduct, effective_from nulls first, effective_to nulls first
    )) as version
      from bom_components
     where org_id = ${gate.user.orgId} and assembly_item_id = ${assemblyItemId}`)
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
    version: version.rows[0]?.version ?? null,
    components: components.rows.map((line) => ({
      ...line,
      operationSeq: manufacturingEnabled ? line.operationSeq : null,
      isByproduct: manufacturingEnabled ? line.isByproduct : false,
    })),
    validItems: validItems.rows,
  })
  },
})
