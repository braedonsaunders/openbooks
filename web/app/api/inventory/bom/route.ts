import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { canonicalDecimal, compareDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

type ComponentInput = {
  componentItemId: string
  quantityPer: string
  sortOrder: number
}

function refusal(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/**
 * Replace one assembly's complete BOM as one controlled configuration write.
 * A table lock deliberately conflicts with buildAssembly's SHARE lock: a build
 * consumes either the entire prior recipe or the entire new recipe, never a
 * partially replaced component set. A per-assembly parent-row lock serializes
 * concurrent replacements (ROW EXCLUSIVE table locks do not conflict with
 * each other).
 */
export async function PUT(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'inventory')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as Record<string, unknown>

  const assemblyItemId = typeof body.assemblyItemId === 'string' ? body.assemblyItemId : ''
  const expectedVersion = body.expectedVersion === null
    ? null
    : typeof body.expectedVersion === 'string'
      ? body.expectedVersion
      : undefined
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!isUuid(assemblyItemId)) return refusal('Choose a valid assembly item.')
  if (expectedVersion === undefined) return refusal('The bill of materials revision is required.')
  if (!reason) return refusal('Explain why this bill of materials is changing.')
  if (!Array.isArray(body.components) || body.components.length === 0) {
    return refusal('A bill of materials requires at least one component line.')
  }
  if (body.components.length > 500) return refusal('A bill of materials cannot exceed 500 component lines.')

  const components: ComponentInput[] = []
  const componentIds = new Set<string>()
  for (let index = 0; index < body.components.length; index += 1) {
    const raw = body.components[index]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return refusal(`Component line ${index + 1} is invalid.`)
    }
    const row = raw as Record<string, unknown>
    const componentItemId = typeof row.componentItemId === 'string' ? row.componentItemId : ''
    const quantityPer = canonicalDecimal(row.quantityPer, 4)
    if (!isUuid(componentItemId)) return refusal(`Choose a valid item on component line ${index + 1}.`)
    if (componentItemId === assemblyItemId) return refusal('An assembly cannot contain itself as a component.')
    if (componentIds.has(componentItemId)) return refusal('Each component item may appear only once in a bill of materials.')
    if (quantityPer === null || compareDecimal(quantityPer, '0') <= 0) {
      return refusal(`Quantity per on component line ${index + 1} must be a positive decimal with at most 4 decimal places.`)
    }
    componentIds.add(componentItemId)
    components.push({ componentItemId, quantityPer, sortOrder: index })
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`lock table bom_components in row exclusive mode`)
      // Serialize concurrent replacements on the parent item row. Two PUTs on
      // an empty BOM would otherwise both read version null and their inserts
      // would union into a recipe nobody wrote; the loser instead re-reads
      // the winner's committed version below and takes the 409 path. NO KEY
      // UPDATE stays compatible with the foreign-key checks on the inserts
      // (same lock as item costing saves). A missing parent row locks
      // nothing — the active-inventory check below still refuses it.
      await tx.execute(sql`
        select id from items
         where id = ${assemblyItemId} and org_id = ${gate.user.orgId}
         for no key update`)

      const versionResult = await tx.execute<{ version: string | null }>(sql`
        select md5(string_agg(
          id::text || ':' || updated_at::text || ':' || component_item_id::text || ':' ||
          quantity_per::text || ':' || sort_order::text,
          ',' order by sort_order, component_item_id
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
      }>(sql`
        select id, component_item_id as "componentItemId",
               quantity_per::text as "quantityPer", sort_order as "sortOrder"
          from bom_components
         where org_id = ${gate.user.orgId} and assembly_item_id = ${assemblyItemId}
         order by sort_order, component_item_id`)

      const itemIds = [assemblyItemId, ...components.map((line) => line.componentItemId)]
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
            created_by, updated_by
          ) values (
            ${gate.user.orgId}, ${assemblyItemId}, ${component.componentItemId},
            ${component.quantityPer}, ${component.sortOrder}, ${gate.user.id}, ${gate.user.id}
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
          quantity_per::text || ':' || sort_order::text,
          ',' order by sort_order, component_item_id
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
    if ('invalidItems' in result) {
      return refusal('Every assembly and component must be an active inventory item in this organization.')
    }
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bill of materials save failed.'
    return refusal(message, 500)
  }
}
