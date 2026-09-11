import 'server-only'

import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requireProjectsFeature } from '../../../lib/projects-gate'
import { isFeatureEnabled } from '../../../lib/features'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, pickString } from '../../../lib/list-params'
import { subsidiaryUiOptions } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadProject } from '../../api/projects/_lib'
import { loadProjectCockpit } from './_cockpit-data'
import type { ProjectDrawer } from './ProjectDrawer'

/**
 * The project list, split into a loader and a spec.
 *
 * Almost all of the page is the universal entity list; what is page-specific
 * is the drawer SLOT, which the native page fills with a fragment of up to
 * three components — a create-redirect, the project flyout, and a related
 * transaction flyout. A spec cannot express a fragment, so the slot takes a
 * LIST of widget names and the host renders them in order. That is the same
 * indirection the empty state uses for its action, widened by one.
 *
 * `requireProjectsFeature` stays where it is: a gated module must refuse
 * before the loader reads anything, not after the spec decides not to render.
 */

type ProjectDrawerProps = Parameters<typeof ProjectDrawer>[0]

type PartyOption = { id: string; display_name: string; [key: string]: unknown }
type ProjectTypeOption = {
  id: string
  name: string
  billingMethod: string | null
  billingProcedure: string
  [key: string]: unknown
}

export interface ProjectsData {
  title: string
  description: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  showNewRedirect: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
  txnDrawer: { id: string; kind: string; projectId: string; formLayoutId?: string } | null
}

export async function loadProjects(
  sp: Record<string, string | string[] | undefined>,
): Promise<ProjectsData> {
  const t = await getTranslations('projects')

  const authz = await requirePermission('projects.read')
  const canManage = can(authz, 'projects.manage')
  const canViewGl = can(authz, 'gl.read')
  const orgId = authz.user.orgId
  await requireProjectsFeature(orgId)
  const applicationPermissions = {
    canRead: can(authz, 'ar.read'),
    canCreate: can(authz, 'ar.create'),
    canApprove: can(authz, 'ar.approve'),
    canInvoice: can(authz, 'ar.post'),
  }

  const projectId = typeof sp.project === 'string' ? sp.project : undefined
  const projectTransactionId = pickString(sp.projectTxn)
  const projectTransactionKind = pickString(sp.projectTxnKind)

  const openProject =
    projectId && projectId !== 'new' && isUuid(projectId)
      ? await loadProject(projectId, orgId, authz.allowedSubsidiaryIds)
      : null

  // party pickers + resolved form layout + cockpit data for the flyout
  // (only when a project is open).
  const [parties, subsidiaries, cockpit, projectTypesRes] = openProject
    ? await Promise.all([
        db.execute<PartyOption>(sql`
          select id, display_name from parties
           where org_id = ${orgId} and is_active
           order by display_name limit 2000`),
        subsidiaryUiOptions(orgId),
        loadProjectCockpit(orgId, openProject.project.id as string, {
          includeApplicationBilling: applicationPermissions.canRead,
        }),
        db.execute<ProjectTypeOption>(sql`
          select id, name, billing_method as "billingMethod",
                 invoicing_profile->>'billingProcedure' as "billingProcedure"
            from project_types where org_id = ${orgId} and is_active order by sort_order, name`),
      ])
    : [null, [], null, null]
  const projectTypes = projectTypesRes?.rows ?? []

  // The Schedule tab is a Projects sub-capability: resolved on the server so a
  // client-side layout choice can never surface a gated feature.
  const [schedulingEnabled, locale] = await Promise.all([
    isFeatureEnabled(orgId, 'projectScheduling'),
    getLocale(),
  ])

  const resolvedForm = openProject
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'project',
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: await loadFieldDefs('projects'),
        lineDefs: [],
        explicitLayoutId: pickString(sp.form),
      })
    : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    canManage,
    currentParams: sp,
    showNewRedirect: projectId === 'new' && canManage,
    drawer:
      openProject && parties && cockpit
        ? {
            remountKey: String(openProject.project.id),
            payload: openProject as unknown as ProjectDrawerProps['payload'],
            parties: parties.rows,
            subsidiaries,
            canManage,
            canViewGl,
            layout: resolvedForm?.layout,
            cockpit,
            projectTypes,
            schedulingEnabled,
            locale,
            initialTab: pickString(sp.projectTab) ?? 'overview',
            applicationPermissions,
          }
        : null,
    txnDrawer:
      openProject && projectTransactionId && isUuid(projectTransactionId) && projectTransactionKind
        ? {
            id: projectTransactionId,
            kind: projectTransactionKind,
            projectId: String(openProject.project.id),
            formLayoutId: pickString(sp.form),
          }
        : null,
  }
}

const f = ref<ProjectsData>()

export function projectsSpec(data: ProjectsData): PageSpec {
  const newProject = { widget: 'new-project', props: {} }
  return page({
    route: '/projects',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newProject.widget, newProject.props, f('canManage'))],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'project',
        sp: data.currentParams,
        emptyAction: data.canManage ? newProject : null,
        // Rendered in the native page's order: the create-redirect first, then
        // the record flyout, then the transaction flyout stacked over it.
        drawer: [
          data.showNewRedirect ? { widget: 'new-project-redirect', props: {} } : null,
          data.drawer ? { widget: 'project-drawer', props: { drawer: data.drawer } } : null,
          data.txnDrawer
            ? { widget: 'related-txn-drawer', props: { drawer: data.txnDrawer } }
            : null,
        ].filter(Boolean),
      }),
    ],
  })
}
