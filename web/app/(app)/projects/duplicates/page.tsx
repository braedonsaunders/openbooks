import { can, requirePermission } from '../../../../lib/authz'
import { requireProjectsFeature } from '../../../../lib/projects-gate'
import { ProjectDuplicatesView } from './ProjectDuplicatesView'

export const dynamic = 'force-dynamic'

/**
 * Duplicate review is a Projects surface: readers may list the groups, but
 * preview and merge both require projects.manage (the merge routes refuse
 * without it), so the page carries that grant into the view instead of
 * offering buttons that 403.
 */
export default async function ProjectDuplicatesPage() {
  const authz = await requirePermission('projects.read')
  await requireProjectsFeature(authz.user.orgId)
  return <ProjectDuplicatesView canMerge={can(authz, 'projects.manage')} />
}
