import 'server-only'
import { can, type Authz } from '../authz'
import type { AccessLevel, FileViewer } from './types'

/**
 * The File Cabinet reader as the Documents page sees it: '*' admins get
 * Manager everywhere; otherwise the org-role baseline (Manager for
 * documents.manage, else Viewer) plus resource_grants. AP intake stays with
 * its owning AP surface, so it is deliberately not readable here. Global
 * search uses the same viewer, so a file is offered exactly when the
 * Documents page would open it.
 */
export function documentsPageViewer(authz: Authz): FileViewer {
  const baseline: AccessLevel = can(authz, 'documents.manage') ? 'manager' : 'viewer'
  return { userId: authz.user.id, isAdmin: can(authz, '*'), baseline, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }
}
