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
  field,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { getGoalWorkspace, getGoal } from '@openbooks/engine/hrm/performance'
import { getAuthz } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { registeredListTable } from '../../../../../lib/list/prepared-spec'
import { hrmGroupTabs } from '../../../../../components/module-home/group-tabs'
export async function loadGoalsWorkspace(
  sp: Record<string, string | undefined>,
) {
  const authz = await getAuthz()
  if (!authz) notFound()
  await requireFeatureEnabled(authz.user.orgId, 'hrmPerformance')
  const t = await getTranslations('hrm.talentWorkspace'),
    hrm = await getTranslations('hrm'),
    base = { orgId: authz.user.orgId, actorId: authz.user.id }
  const workspace = await getGoalWorkspace({
      ...base,
      employmentId: sp.employee,
    }),
    closeHref =
      '/hrm/performance/goals' + (sp.employee ? '?employee=' + sp.employee : '')
  const initial =
    sp.goal && sp.goal !== 'new'
      ? await getGoal({ ...base, goalId: sp.goal })
      : null
  const canCreate = workspace.employees.some((e) => e.canWrite)
  const canWrite = initial
    ? workspace.goals.find((g) => g.id === initial.goal.id)?.canWrite === true
    : workspace.employees.some((e) => e.canWrite)
  return {
    title: t('goals'),
    tabs: await hrmGroupTabs(authz, '/hrm/performance/goals'),
    canWrite: canCreate,
    addLabel: t('newGoal'),
    addHref: closeHref + (sp.employee ? '&' : '?') + 'goal=new',
    currentParams: { employee: sp.employee },
    filters: [
      {
        paramKey: 'employee',
        label: t('employee'),
        allLabel: t('allVisible'),
        options: workspace.employees,
      },
    ],
    rows: workspace.goals.map((g) => ({
      ...g,
      statusLabel: hrm(`me.goalStatus.${g.status}`),
      progress: g.progressPercent + '%',
      due: g.dueOn ?? '—',
      href: closeHref + (sp.employee ? '&' : '?') + 'goal=' + g.id,
    })),
    empty: t('noGoals'),
    columns: {
      title: t('goalTitle'),
      employee: t('employee'),
      status: t('status'),
      progress: t('progress'),
      due: t('due'),
    },
    editor: sp.goal
      ? {
          initial,
          canWrite,
          employees: workspace.employees.filter((e) => e.canWrite),
          closeHref,
        }
      : null,
  }
}
type Data = Awaited<ReturnType<typeof loadGoalsWorkspace>>
export function goalsWorkspaceSpec(data: Data): PageSpec {
  return page({
    route: '/hrm/performance/goals',
    layout: 'list',
    header: [
      pageHeader({
        title: field('title'),
        actions: [
          widget(
            'link-button',
            {
              href: field('addHref'),
              label: field('addLabel'),
              iconKey: 'plus',
            },
            field('canWrite'),
          ),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('list-toolbar', {
        basePath: '/hrm/performance/goals',
        currentParams: data.currentParams,
        filters: data.filters,
      }),
      registeredListTable('hrm_goal_worklist', {
        rows: field('rows'),
        rowKey: field('id'),
        empty: { title: field('empty') },
        columns: [
          column(data.columns.title, link(field('title'), field('href'))),
          ...(['employee', 'status', 'progress', 'due'] as const).map((key) =>
            column(
              data.columns[key],
              text(field(key === 'status' ? 'statusLabel' : key)),
            ),
          ),
        ],
      }),
      ...(data.editor ? [widgetBlock('hrm-goal-editor', data.editor)] : []),
    ],
  })
}
