import 'server-only'
import { getTranslations } from 'next-intl/server'
import type { ModuleHomeTab } from '../../../components/module-home/ui'

/**
 * The Compliance workspace's route-tab strip, defined once so every page in the
 * module renders the identical strip (the /ap idiom). Lien waivers need a
 * project, so that tab appears only when the Projects gate is on — the tab
 * disappearing and the route 404ing are the same condition, read from the same
 * place.
 */
export async function complianceTabs(
  activeHref: string,
  opts: { projectsEnabled: boolean },
): Promise<ModuleHomeTab[]> {
  const t = await getTranslations('compliance')
  const tabs = [
    { href: '/compliance', key: 'tabs.overview' },
    { href: '/compliance/vendors', key: 'tabs.vendors' },
    ...(opts.projectsEnabled ? [{ href: '/compliance/lien-waivers', key: 'tabs.lienWaivers' }] : []),
    { href: '/compliance/information-returns', key: 'tabs.informationReturns' },
  ]
  return tabs.map((tab) => ({
    href: tab.href,
    label: t(tab.key),
    active: activeHref === tab.href,
  }))
}
