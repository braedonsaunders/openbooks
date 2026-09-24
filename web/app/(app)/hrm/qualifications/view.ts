import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  link,
  page,
  pageHeader,
  panel,
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { loadQualificationsPage as loadQualifications } from '../../../../lib/hrm/qualifications'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'

/**
 * Qualifications home: four stat tiles (expiring in 30 days, expired and
 * still assigned, pending verification, projects with unmet
 * requirements), the ledger table by worker with status and type filter
 * chips, a drawer per qualification with evidence and events, and route
 * sub-tabs for Requirements (with the coverage matrix: rows = crew,
 * cols = required types, cells = status chips, one column per required
 * type with horizontal scroll) and
 * Alerts. Renders when hrmCertifications is on and the actor holds
 * hrm.certifications.read — the loader 404s otherwise.
 */

const f = item

export function qualificationsSpec(data: NonNullable<Awaited<ReturnType<typeof loadQualifications>>>): PageSpec {
  const section = data.section
  return page({
    route: '/hrm/qualifications',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('recordHref'), label: f('recordLabel'), iconKey: 'plus' }, f('canManage')),
          widget('link-button', { href: f('settingsHref'), label: f('settingsLabel'), iconKey: 'cog', variant: 'outline' }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
      grid('grid grid-cols-2 gap-4 xl:grid-cols-4', [
        statTile({ iconKey: f('tiles.0.iconKey'), accent: f('tiles.0.accent'), label: f('tiles.0.label'), value: f('tiles.0.value'), tone: f('tiles.0.tone') }),
        statTile({ iconKey: f('tiles.1.iconKey'), accent: f('tiles.1.accent'), label: f('tiles.1.label'), value: f('tiles.1.value'), tone: f('tiles.1.tone') }),
        statTile({ iconKey: f('tiles.2.iconKey'), accent: f('tiles.2.accent'), label: f('tiles.2.label'), value: f('tiles.2.value'), tone: f('tiles.2.tone') }),
        statTile({ iconKey: f('tiles.3.iconKey'), accent: f('tiles.3.accent'), label: f('tiles.3.label'), value: f('tiles.3.value'), tone: f('tiles.3.tone') }),
      ]),
      widgetBlock('filter-chips', {
        basePath: '/hrm/qualifications',
        currentParams: data.currentParams,
        paramKey: 'section',
        label: f('sectionLabel'),
        allLabel: f('sectionOptions.0.label'),
        options: data.sectionOptions,
      }),
      panel({
        title: f('taxonomyTitle'),
        bodyClassName: 'p-4',
        blocks: [
          widgetBlock('setup-section', {
            entityKey: 'qualification-types',
            basePath: '/hrm/qualifications',
            sp: data.currentParams,
          }),
          widgetBlock('setup-section', {
            entityKey: 'qualification-settings',
            basePath: '/hrm/qualifications',
            sp: data.currentParams,
          }),
        ],
      }),
      ...(section === 'ledger'
        ? [
            widgetBlock('filter-chips', {
              basePath: '/hrm/qualifications',
              currentParams: data.currentParams,
              paramKey: 'segment',
              label: f('segmentsLabel'),
              allLabel: f('allLabel'),
              options: data.segments,
            }),
            widgetBlock('filter-chips', {
              basePath: '/hrm/qualifications',
              currentParams: data.currentParams,
              paramKey: 'type',
              label: f('typesLabel'),
              allLabel: f('typesAll'),
              options: data.typeOptions,
            }),
            panel({
              title: f('listTitle'),
              bodyClassName: 'min-h-0 overflow-y-auto p-0',
              className: 'min-h-0 flex-1',
              blocks: [
                table({
                  variant: 'app',
                  rows: f('rows'),
                  rowKey: item('id'),
                  columns: [
                    column(f('columns.worker'), link(item('workerName'), item('workerHref'))),
                    column(f('columns.type'), text(item('typeCode'))),
                    column(f('columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
                    column(f('columns.expiry'), text(item('expiryLabel'), { className: 'tabular-nums' })),
                    column('', link(item('openLabel'), item('openHref'))),
                  ],
                  empty: { title: f('emptyTitle'), description: f('emptyDescription') },
                }),
                widgetBlock(
                  'hrm-qualification-dialog',
                  {
                    qualificationId: f('dialogQualificationId'),
                    closeHref: f('dialogCloseHref'),
                    recordOpen: f('recordOpen'),
                  },
                  f('dialogVisible'),
                ),
              ],
            }),
          ]
        : section === 'requirements'
          ? [
              panel({
                title: f('requirementsTitle'),
                bodyClassName: 'min-h-0 overflow-y-auto p-0',
                blocks: [
                  table({
                    variant: 'app',
                    rows: f('requirements'),
                    rowKey: item('id'),
                    columns: [
                      column(f('columns.subject'), text(item('subjectName'))),
                      column(f('columns.type'), text(item('typeCode'))),
                      column(f('columns.severity'), badge(item('severity'), { variant: item('severityVariant') })),
                      column(f('columns.window'), text(item('windowLabel'), { className: 'tabular-nums' })),
                    ],
                    empty: { title: f('requirementsEmpty') },
                  }),
                ],
              }),
              panel({
                title: f('coverageTitle'),
                bodyClassName: 'min-h-0 overflow-auto p-0',
                blocks: [
                  widgetBlock('filter-chips', {
                    basePath: '/hrm/qualifications',
                    currentParams: data.currentParams,
                    paramKey: 'projectId',
                    label: f('coverageProjectLabel'),
                    allLabel: f('coverageProjectAll'),
                    options: data.projectOptions,
                  }),
                  table({
                    variant: 'app',
                    rows: f('coverageRows'),
                    rowKey: item('employmentId'),
                    columns: [
                      column(f('columns.worker'), text(item('workerName'))),
                      // One column per required type, in loader order: the
                      // matrix never hides the 7th+ type, and the panel
                      // scrolls horizontally past the viewport width.
                      ...data.coverageTypes.map((type, index) =>
                        column(type.code, badge(item(`cells.${index}.label`), { variant: item(`cells.${index}.variant`) })),
                      ),
                    ],
                    empty: { title: f('coverageEmpty') },
                  }),
                ],
              }),
            ]
          : [
              panel({
                title: f('alertsTitle'),
                bodyClassName: 'min-h-0 overflow-y-auto p-0',
                blocks: [
                  table({
                    variant: 'app',
                    rows: f('alerts'),
                    rowKey: item('id'),
                    columns: [
                      column(f('columns.worker'), text(item('workerName'))),
                      column(f('columns.type'), text(item('typeLabel'))),
                      column(f('columns.due'), text(item('dueOn'), { className: 'tabular-nums' })),
                      column(f('columns.sent'), text(item('sentLabel'))),
                    ],
                    empty: { title: f('alertsEmpty') },
                  }),
                ],
              }),
            ]),
    ],
  })
}

export async function loadQualificationsPage(
  sp: Record<string, string | undefined>,
): Promise<NonNullable<Awaited<ReturnType<typeof loadQualifications>>>> {
  // The page gate lives here — where the route-gate scanner reads — and
  // the loader enforces nothing twice: it takes the authorized session
  // as input. Off hides the surface, never the data.
  const authz = await requirePermission('hrm.certifications.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrmCertifications')
  const canManage = await (async () => {
    try {
      await requirePermission('hrm.certifications.manage')
      return true
    } catch {
      return false
    }
  })()
  return loadQualifications(authz, sp, canManage)
}

export async function qualificationsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('qualifications.title')
}
