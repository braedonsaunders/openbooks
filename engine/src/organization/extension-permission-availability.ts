import { sql } from 'drizzle-orm';
import { db, type SqlExecutor } from '../platform/db.ts';
import { isCataloguePermission } from './permissions.ts';

/** Historical declarations remain evidence; only a currently installed active declaration is effective. */
export async function extensionPermissionAvailability(orgId: string, tx: SqlExecutor = db): Promise<{ active: string[]; inactive: string[] }> {
  const rows = (await tx.execute<{ key: string; active: boolean }>(sql`
    select declaration->>'key' as key,
      bool_or(m.status = 'installed' and m.active_version_id = v.id and (select settings->'features'->'apps' from orgs where id=${orgId}) is distinct from 'false'::jsonb) as active
    from apps m join app_versions v on v.app_id = m.id and v.org_id = m.org_id
    cross join lateral jsonb_array_elements(coalesce(v.manifest->'contributions', '[]'::jsonb)) declaration
    where m.org_id = ${orgId} and declaration->>'kind' = 'permission'
    group by declaration->>'key'
  `)).rows;
  const valid = rows.filter(({key}) => typeof key === 'string' && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/.test(key) && !isCataloguePermission(key));
  return { active: valid.filter((row) => row.active).map((row) => row.key), inactive: valid.filter((row) => !row.active).map((row) => row.key) };
}

/** Exact runtime denies preserve wildcards and all unrelated permission meanings. */
export function denyInactiveExtensionPermissions(permissions: Set<string>, inactive: readonly string[]): Set<string> {
  for (const permission of inactive) { permissions.delete(permission); permissions.add(`!${permission}`); }
  return permissions;
}
