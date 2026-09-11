import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { frame, grid, page, pageHeader, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { currentUser } from '../../../../lib/auth'
import { listApps } from '../../../../lib/apps/store'
import { defaultNavConfig, type NavAppOption, type OrgNavConfig } from '../../../../lib/nav/registry'

/**
 * The navigation editor, split into a loader and a spec.
 *
 * The editor is a fully client-interactive component (NavEditor owns unsaved
 * state, prompt() dialogs, a 4-pin mobile limit with a toast, and a PUT save)
 * that can never be decomposed into spec blocks — the same position the
 * customization page takes for its Form/ListView designers. So the spec binds
 * exactly one widgetBlock (`nav-editor`) carrying the two loader-resolved
 * props the native page already builds: the saved-or-default config and the
 * installed-app options. No new vocabulary.
 *
 * The native query, filter and fallback logic is copied verbatim below.
 */

export interface NavigationAdminData {
  title: string
  description: string
  backHref: string
  backLabel: string
  initial: OrgNavConfig
  apps: NavAppOption[]
}

export async function loadNavigationAdmin(
  _sp: Record<string, string | string[] | undefined>,
): Promise<NavigationAdminData | null> {
  const user = await currentUser()
  if (!user) return null
  const t = await getTranslations('admin.navigation')
  const tHub = await getTranslations('admin.hub')

  const [r, apps] = await Promise.all([
    db.execute<{ config: OrgNavConfig }>(sql`select config from org_nav_configs where org_id = ${user.orgId} limit 1`),
    listApps(user.orgId),
  ])
  const saved = r.rows[0]?.config
  const navApps = apps
    .filter((app) => app.status === 'installed' && app.activeVersionId)
    .map((app) => ({
      key: app.key,
      name: app.manifest?.nav?.label?.trim() || app.name,
      iconKey: app.manifest?.nav?.icon?.trim() || app.iconKey,
    }))
  const config = saved?.version === 2 ? saved : defaultNavConfig()

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    initial: config,
    apps: navApps,
  }
}

const f = ref<NavigationAdminData>()

export function navigationAdminSpec(data: NavigationAdminData): PageSpec {
  return page({
    route: '/admin/navigation',
    // The native page sits inside PageContainer (whole-body scroll, max-w-3xl
    // inner) — ListPageLayout's sticky-header chrome would nest a second shell
    // around it, so this is the analytics-hub precedent: `bare` + the exact
    // native shell as a frame.
    layout: 'bare',
    header: [],
    body: [
      frame('page-container', [pageHeader({ title: f('title'), description: f('description'), back: { href: f('backHref'), label: f('backLabel') } }), grid('mt-6', [widgetBlock('nav-editor', { initial: data.initial, apps: data.apps })])], {
        className: 'max-w-3xl',
      }),
    ],
  })
}
