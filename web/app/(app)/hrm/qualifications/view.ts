import 'server-only'

import { registeredListTable } from '../../../../lib/list/prepared-spec'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  link,
  page,
  pageHeader,
  pagination,
  panel,
  statTile,
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
 * requirements), the ledger register by worker with the section, status
 * and type filters on the list's shared toolbar slot, a drawer per
 * qualification with evidence and events, and route sub-tabs for
 * Requirements (with the coverage matrix: rows = crew, cols = required
 * types, cells = status chips, one column per required type with
 * horizontal scroll) and Alerts. Renders when hrmCertifications is on
 * and the actor holds hrm.certifications.read — the loader 404s
 * otherwise.
 */

const f = item

type QualificationsData = NonNullable<Awaited<ReturnType<typeof loadQualifications>>>

// The ledger/requirements/alerts switch rides each list's toolbar slot —
// one switch beside the list it switches, never a lone chips row above a
// titled panel. Callers append their own filters after it.
function sectionFilter(data: QualificationsData) {
  return {
    paramKey: 'section',
    label: f('sectionLabel'),
    allLabel: f('sectionOptions.0.label'),
    options: data.sectionOptions,
  }
}

export function qualificationsSpec(data: QualificationsData): PageSpec {
  const section = data.section
  return page({
    route: '/hrm/qualifications',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col gap-4',
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
      grid('grid grid-cols-2 gap-4 xl:grid-cols-4', [
        statTile({ iconKey: f('tiles.0.iconKey'), accent: f('tiles.0.accent'), label: f('tiles.0.label'), value: f('tiles.0.value'), tone: f('tiles.0.tone') }),
        statTile({ iconKey: f('tiles.1.iconKey'), accent: f('tiles.1.accent'), label: f('tiles.1.label'), value: f('tiles.1.value'), tone: f('tiles.1.tone') }),
        statTile({ iconKey: f('tiles.2.iconKey'), accent: f('tiles.2.accent'), label: f('tiles.2.label'), value: f('tiles.2.value'), tone: f('tiles.2.tone') }),
        statTile({ iconKey: f('tiles.3.iconKey'), accent: f('tiles.3.accent'), label: f('tiles.3.label'), value: f('tiles.3.value'), tone: f('tiles.3.tone') }),
      ]),
      panel({
        title: f('taxonomyTitle'),
        bodyClassName: 'p-4',
        blocks: [
          widgetBlock('setup-section', {
            entityKey: 'qualification-types',
            basePath: '/hrm/qualifications',
            sp: data.currentParams,
            rowParam: 'qtype',
          }),
          widgetBlock('setup-section', {
            entityKey: 'qualification-settings',
            basePath: '/hrm/qualifications',
            sp: data.currentParams,
            rowParam: 'qsettings',
          }),
        ],
      }),
      ...(section === 'ledger'
        ? [
            registeredListTable(
              'hrm_qualifications_ledger',
              {
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
              },
              [
                widget('list-toolbar', {
                  basePath: '/hrm/qualifications',
                  currentParams: data.currentParams,
                  filters: [
                    sectionFilter(data),
                    {
                      paramKey: 'segment',
                      label: f('segmentsLabel'),
                      allLabel: f('allLabel'),
                      options: data.segments,
                    },
                    {
                      paramKey: 'type',
                      label: f('typesLabel'),
                      allLabel: f('typesAll'),
                      options: data.typeOptions,
                    },
                  ],
                }),
              ],
            ),
            widgetBlock(
              'hrm-qualification-dialog',
              {
                qualificationId: f('dialogQualificationId'),
                closeHref: f('dialogCloseHref'),
                recordOpen: f('recordOpen'),
                // Verify, Renew and Revoke render only with the
                // manage grant, never on stored status alone.
                canManage: f('canManage'),
              },
              f('dialogVisible'),
            ),
          ]
        : section === 'requirements'
          ? [
              // The requirement editor stays: it is the workspace control,
              // never a collection row. The register below it is the list.
              widgetBlock('hrm-qualification-requirement-manager', {
                today: f('today'),
                types: f('requirementTypeOptions'),
                labels: f('requirementManagerLabels'),
              }, f('canManage')),
              registeredListTable(
                'hrm_qualifications_requirements',
                {
                  variant: 'app',
                  rows: f('requirements'),
                  rowKey: item('id'),
                  columns: [
                    column(f('columns.subject'), text(item('subjectName'))),
                    column(f('columns.type'), text(item('typeCode'))),
                    column(f('columns.severity'), badge(item('severityLabel'), { variant: item('severityVariant') })),
                    column(f('columns.window'), text(item('windowLabel'), { className: 'tabular-nums' })),
                    ...(data.canManage ? [column('', {
                      kind: 'widget',
                      widget: 'hrm-qualification-requirement-remove',
                      props: {
                        id: item('id'),
                        label: data.requirementsRemoveLabel,
                        confirmLabel: data.requirementsRemoveConfirm,
                        failedLabel: data.requirementsRemoveFailed,
                        canManage: data.canManage,
                      },
                    })] : []),
                  ],
                  empty: { title: f('requirementsEmpty') },
                },
                [
                  widget('list-toolbar', {
                    basePath: '/hrm/qualifications',
                    currentParams: data.currentParams,
                    filters: [sectionFilter(data)],
                  }),
                ],
              ),
              registeredListTable(
                'hrm_qualifications_coverage',
                {
                  variant: 'app',
                  rows: f('coverageRows'),
                  rowKey: item('employmentId'),
                  columns: [
                    column(f('columns.worker'), text(item('workerName'))),
                    // One column per required type, in loader order: the
                    // matrix never hides the 7th+ type and scrolls
                    // horizontally past the viewport width.
                    ...data.coverageTypes.map((type, index) =>
                      column(type.code, badge(item(`cells.${index}.label`), { variant: item(`cells.${index}.variant`) })),
                    ),
                  ],
                  empty: { title: f('coverageEmpty') },
                },
                [
                  widget('list-toolbar', {
                    basePath: '/hrm/qualifications',
                    currentParams: data.currentParams,
                    filters: [
                      sectionFilter(data),
                      {
                        paramKey: 'projectId',
                        label: f('coverageProjectLabel'),
                        allLabel: f('coverageProjectAll'),
                        options: data.projectOptions,
                      },
                    ],
                  }),
                ],
              ),
              // The crew pages 50 at a time: the pager loads the
              // remainder instead of silently cutting past the cap.
              {
                ...pagination({
                  basePath: '/hrm/qualifications',
                  total: f('coverageTotal'),
                  page: f('coveragePage'),
                  perPage: f('coveragePerPage'),
                  pageParamKey: 'crewPage',
                }),
                when: f('coverageProjectId'),
              },
            ]
          : [
              registeredListTable(
                'hrm_qualifications_alerts',
                {
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
                },
                [
                  widget('list-toolbar', {
                    basePath: '/hrm/qualifications',
                    currentParams: data.currentParams,
                    filters: [sectionFilter(data)],
                  }),
                ],
              ),
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
