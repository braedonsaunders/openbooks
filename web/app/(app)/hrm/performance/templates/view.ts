import 'server-only'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  page,
  pageHeader,
  widget,
  widgetBlock,
  column,
  link,
  text,
  badge,
  field,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import {
  listTemplateDocuments,
  PerformanceUpgradeRequiredError,
  listTemplateCompetencies,
} from '@openbooks/engine/hrm/performance'
import { can, getAuthz } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { registeredListTable } from '../../../../../lib/list/prepared-spec'
import { hrmGroupTabs } from '../../../../../components/module-home/group-tabs'
export async function loadTemplateWorkspace(sp: Record<string, string | undefined>) {
  const authz = await getAuthz()
  if (!authz || !(can(authz, 'hrm.performance.manage') || can(authz, 'admin.setup.manage')))
    notFound()
  await requireFeatureEnabled(authz.user.orgId, 'hrmPerformance')
  const t = await getTranslations('hrm.talentWorkspace')
  let upgradeRequired = false
  let templates: Awaited<ReturnType<typeof listTemplateDocuments>> = []
  try {
    templates = await listTemplateDocuments({ orgId: authz.user.orgId, actorId: authz.user.id })
  } catch (error) {
    if (!(error instanceof PerformanceUpgradeRequiredError)) throw error
    upgradeRequired = true
  }
  const canEdit = !upgradeRequired && authz.allowedSubsidiaryIds === null
  const competencies = canEdit
    ? await listTemplateCompetencies({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      })
    : []
  const selected = sp.template === 'new' ? null : templates.find((t) => t.id === sp.template)
  if (!upgradeRequired && sp.template && sp.template !== 'new' && !selected) notFound()
  return {
    upgradeRequired,
    upgradeTitle: t('upgradeRequired'),
    upgradeDescription: t('upgradeDescription'),
    title: t('templates'),
    description: t('templateDescription'),
    tabs: await hrmGroupTabs(authz, '/hrm/performance/templates'),
    canEdit,
    addLabel: t('newTemplate'),
    addHref: '/hrm/performance/templates?template=new',
    rows: templates.map((template) => ({
      id: template.id,
      name: template.draft.name,
      status: !template.published
        ? t('draft')
        : JSON.stringify(template.draft) !== JSON.stringify(template.published)
          ? t('publishedWithDraft')
          : t('published'),
      questions: String(template.draft.sections.reduce((n, s) => n + s.questions.length, 0)),
      version: template.publishedVersion
        ? t('version', { version: template.publishedVersion })
        : template.published
          ? t('existingPublished')
          : '—',
      usage: t('cycleCount', { count: template.cycleCount }),
      href: '/hrm/performance/templates?template=' + template.id,
    })),
    columns: {
      name: t('template'),
      status: t('status'),
      questions: t('questions'),
      version: t('publishedVersionLabel'),
      usage: t('usedBy'),
    },
    empty: t('noTemplates'),
    editor:
      !upgradeRequired && sp.template
        ? {
            initial: selected ?? null,
            closeHref: '/hrm/performance/templates',
            canEdit,
            competencies,
          }
        : null,
  }
}
type Data = Awaited<ReturnType<typeof loadTemplateWorkspace>>
export function templateWorkspaceSpec(data: Data): PageSpec {
  return page({
    route: '/hrm/performance/templates',
    layout: 'list',
    header: [
      pageHeader({
        title: field('title'),
        description: field('description'),
        actions: [
          widget(
            'link-button',
            {
              href: field('addHref'),
              label: field('addLabel'),
              iconKey: 'plus',
            },
            field('canEdit'),
          ),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      ...(data.upgradeRequired
        ? [
            widgetBlock('empty-state', {
              title: data.upgradeTitle,
              description: data.upgradeDescription,
            }),
          ]
        : [
            registeredListTable('hrm_review_template_documents', {
              rows: field('rows'),
              rowKey: field('id'),
              empty: { title: field('empty') },
              columns: [
                column(data.columns.name, link(field('name'), field('href'))),
                column(data.columns.status, badge(field('status'))),
                column(data.columns.questions, text(field('questions'))),
                column(data.columns.version, text(field('version'))),
                column(data.columns.usage, text(field('usage'))),
              ],
            }),
          ]),
      ...(data.editor ? [widgetBlock('hrm-review-template-designer', data.editor)] : []),
    ],
  })
}
