import { sql } from "drizzle-orm";
import {
  RECORD_TYPES,
  defaultFormLayout,
  defaultListView,
} from "@openbooks/customization";
import { db } from "./db.ts";

const DEFAULT_FORM_NAME = "Default form";
const DEFAULT_VIEW_NAME = "Default view";

/**
 * Provision editable, tenant-owned baseline forms and views during an explicit
 * organization setup command. Live record resolution has a pure system
 * fallback and must never call this function from a page render or GET route.
 */
export async function ensureCustomizationDefaults(args: {
  orgId: string;
  actorId?: string | null;
  recordTypes?: string[];
}): Promise<void> {
  const requested = new Set(
    args.recordTypes ?? RECORD_TYPES.map((recordType) => recordType.key),
  );
  const metas = RECORD_TYPES.filter((recordType) =>
    requested.has(recordType.key),
  );

  await db.transaction(async (tx) => {
    for (const meta of metas) {
      if (meta.supportsForms !== false) {
        const layout = defaultFormLayout(meta.key);
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
            true, null, ${layout}, ${args.actorId ?? null}, ${args.actorId ?? null}
          )
          on conflict (org_id, record_type, name) do nothing
        `);
        await tx.execute(sql`
          update form_layouts
             set is_default = true, is_active = true, updated_at = now(),
                 updated_by = ${args.actorId ?? null}
           where org_id = ${args.orgId} and record_type = ${meta.key}
             and name = ${DEFAULT_FORM_NAME}
             and not exists (
               select 1 from form_layouts
                where org_id = ${args.orgId} and record_type = ${meta.key} and is_default
             )
        `);
      }

      const config = defaultListView(meta.key);
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
          true, ${config}, ${args.actorId ?? null}, ${args.actorId ?? null}
        )
        on conflict (org_id, scope, record_type, name) do nothing
      `);
      await tx.execute(sql`
        update list_views
           set is_default = true, is_active = true, updated_at = now(),
               updated_by = ${args.actorId ?? null}
         where org_id = ${args.orgId} and record_type = ${meta.key}
           and scope = 'org' and name = ${DEFAULT_VIEW_NAME}
           and not exists (
             select 1 from list_views
              where org_id = ${args.orgId} and record_type = ${meta.key}
                and scope = 'org' and is_default
           )
      `);
    }
  });
}
