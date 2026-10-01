import 'server-only'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/platform/database'
import { parseNativeExtension } from '../apps/native-ui'

/** Installed, version-pinned native screens are configurable local destinations. */
export async function nativeAppNavigationCatalog(orgId: string, executor: SqlExecutor = db) {
  const result = await executor.execute<{ key: string; name: string; content: string }>(sql`
    select a.key, a.name, f.content
      from apps a
      join app_versions v on v.id = a.active_version_id and v.org_id = a.org_id
      join app_files f on f.app_id = a.id and f.org_id = a.org_id
        and f.version_id = v.id and f.path = v.manifest #>> '{frontend,entry}' and not f.is_binary
     where a.org_id = ${orgId} and a.status = 'installed'
       and v.manifest #>> '{frontend,renderer}' = 'native'
     order by a.sort_order, a.name
  `)
  return result.rows.map((app) => ({
    id: `app:${app.key}`, label: app.name,
    tabs: parseNativeExtension(app.content).screens.map((screen) => ({
      href: `/apps/${app.key}?screen=${encodeURIComponent(screen.key)}`, label: screen.title,
    })),
  }))
}
