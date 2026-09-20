import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadHrmReports, type HrmReportCard, type HrmReportsData } from '../../../../lib/hrm/reports'

/**
 * The workforce reports launch pad, split into a loader and a spec.
 *
 * Cards reuse the shared `admin-hub-card` widget — the same card the admin
 * hub composes — over loader-resolved hrefs and strings: the headcount
 * statement preset (the org's own plan row by slug, builder catalog while
 * the seed has never materialized) plus one card per workforce report
 * entity into the builder. No second card component, no bespoke list.
 */

const f = ref<HrmReportsData>()

function card(card: HrmReportCard) {
  return widgetBlock('admin-hub-card', {
    href: card.href,
    iconKey: card.iconKey,
    title: card.title,
    description: card.description,
    accent: card.accent,
  })
}

export function hrmReportsSpec(data: HrmReportsData): PageSpec {
  return page({
    route: '/hrm/reports',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        panel({
          title: f('presetTitle'),
          iconKey: 'scroll-text',
          hint: f('presetHint'),
          bodyClassName: 'min-h-0',
          className: 'shrink-0',
          blocks: [...(data.preset ? [card(data.preset)] : [])],
        }),
        panel({
          title: f('entitiesTitle'),
          iconKey: 'database',
          hint: f('entitiesHint'),
          bodyClassName: 'min-h-0',
          className: 'shrink-0',
          blocks: [
            grid('grid grid-cols-1 gap-3 sm:grid-cols-2', [
              ...data.entities.map((entity: HrmReportCard) => card(entity)),
              card(data.hubCard),
            ]),
          ],
        }),
      ]),
    ],
  })
}

export async function loadHrmReportsPage(): Promise<HrmReportsData> {
  // The page gate lives here — where the route-gate scanner reads: the
  // employment read grant for the module plus the reports grant the
  // builder uses, and the hrm switch with a 404. The loader enforces
  // nothing twice; it takes the authorized session as input.
  const authz = await requirePermission('hrm.employment.read')
  await requirePermission('reports.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadHrmReports(authz)
}

export async function hrmReportsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('reports.title')
}
