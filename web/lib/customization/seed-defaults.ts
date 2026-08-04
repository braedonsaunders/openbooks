import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  RECORD_TYPES,
  defaultFormLayout,
  defaultListView,
} from '@openbooks/customization'

const DEFAULT_FORM_NAME = 'Default form'
const DEFAULT_VIEW_NAME = 'Default view'

/**
 * Provision real, tenant-owned baseline forms and views. This replaces the old
 * virtual fallback: admins can edit the baseline in place and the same stored
 * row is what live record pages resolve. Idempotent and safe under concurrent
 * first requests through the existing unique name indexes.
 */
export async function ensureCustomizationDefaults(args: {
  orgId: string
  actorId: string
  recordTypes?: string[]
}) {
  const requested = new Set(args.recordTypes ?? RECORD_TYPES.map((recordType) => recordType.key))
  const metas = RECORD_TYPES.filter((recordType) => requested.has(recordType.key))

  await db.transaction(async (tx) => {
    for (const meta of metas) {
      if (meta.supportsForms !== false) {
        const layout = defaultFormLayout(meta.key)
        await tx.execute(sql`
          insert into form_layouts (
            org_id, record_type, name, description, is_default, is_active,
            allowed_roles, layout, created_by, updated_by
          )
          values (
            ${args.orgId}, ${meta.key}, ${DEFAULT_FORM_NAME}, null,
            not exists (
              select 1 from form_layouts
               where org_id = ${args.orgId} and record_type = ${meta.key} and is_default
            ),
            true, null, ${layout}, ${args.actorId}, ${args.actorId}
          )
          on conflict (org_id, record_type, name) do nothing
        `)
        await tx.execute(sql`
          update form_layouts
             set is_default = true, is_active = true, updated_at = now(), updated_by = ${args.actorId}
           where org_id = ${args.orgId} and record_type = ${meta.key} and name = ${DEFAULT_FORM_NAME}
             and not exists (
               select 1 from form_layouts
                where org_id = ${args.orgId} and record_type = ${meta.key} and is_default
             )
        `)

      }

      const config = defaultListView(meta.key)
      await tx.execute(sql`
        insert into list_views (
          org_id, record_type, name, scope, owner_id, is_default, is_active,
          config, created_by, updated_by
        )
        values (
          ${args.orgId}, ${meta.key}, ${DEFAULT_VIEW_NAME}, 'org', null,
          not exists (
            select 1 from list_views
             where org_id = ${args.orgId} and record_type = ${meta.key}
               and scope = 'org' and is_default
          ),
          true, ${config}, ${args.actorId}, ${args.actorId}
        )
        on conflict (org_id, scope, record_type, name) do nothing
      `)
      await tx.execute(sql`
        update list_views
           set is_default = true, is_active = true, updated_at = now(), updated_by = ${args.actorId}
         where org_id = ${args.orgId} and record_type = ${meta.key}
           and scope = 'org' and name = ${DEFAULT_VIEW_NAME}
           and not exists (
             select 1 from list_views
              where org_id = ${args.orgId} and record_type = ${meta.key}
                and scope = 'org' and is_default
           )
      `)
    }
  })
}
