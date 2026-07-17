import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, pickString } from '../../../lib/list-params'
import { subsidiaryOptions } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadProject } from '../../api/projects/_lib'
import { NewProjectButton } from './NewProjectButton'
import { NewProjectRedirect } from './NewProjectRedirect'
import { ProjectDrawer } from './ProjectDrawer'

export const dynamic = 'force-dynamic'

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('projects')

  const authz = await requirePermission('projects.read')
  const canManage = can(authz, 'projects.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const projectId = typeof sp.project === 'string' ? sp.project : undefined

  const openProject =
    projectId && projectId !== 'new' && isUuid(projectId) ? await loadProject(projectId, orgId) : null

  // party pickers + resolved form layout for the drawer (only when it's open).
  const [parties, subsidiaries] = openProject
    ? await Promise.all([
        db.execute(sql`
          select id, display_name from parties
           where org_id = ${orgId} and is_active
           order by display_name limit 2000`) as any,
        subsidiaryOptions(),
      ])
    : [null, []]

  const resolvedForm = openProject
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'project',
        userRoles: [authz.user.role],
        headerDefs: await loadFieldDefs('projects'),
        lineDefs: [],
        explicitLayoutId: pickString(sp.form),
      })
    : null

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('list.title')}
          description={t('list.description')}
          actions={canManage ? <NewProjectButton /> : undefined}
        />
      }
    >
      <EntityListView
        recordType="project"
        orgId={orgId}
        userId={authz.user.id}
        canManage={canManage}
        sp={sp}
        emptyAction={canManage ? <NewProjectButton /> : undefined}
        drawer={
          <>
            {projectId === 'new' && canManage ? <NewProjectRedirect /> : null}
            {openProject && parties ? (
              <ProjectDrawer
                key={String(openProject.project.id)}
                payload={openProject as any}
                parties={parties.rows}
                subsidiaries={subsidiaries}
                canManage={canManage}
                layout={resolvedForm?.layout}
              />
            ) : null}
          </>
        }
      />
    </ListPageLayout>
  )
}
