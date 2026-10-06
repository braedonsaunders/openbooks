import type { AccessLevel, FileViewer } from './types'

/**
 * The File Cabinet reader as the Documents page sees it: '*' admins get
 * Manager everywhere; otherwise the org-role baseline (Manager for
 * documents.manage, else Viewer) plus resource_grants. AP intake stays with
 * its owning AP surface, so it is deliberately not readable here. Global
 * search uses the same viewer, so a file is offered exactly when the
 * Documents page would open it. Callers pass their own permission answers,
 * so this stays free of the request-scoped authorization module.
 */
export function documentsPageViewer(reader: {
  userId: string
  isAdmin: boolean
  canManage: boolean
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): FileViewer {
  const baseline: AccessLevel = reader.canManage ? 'manager' : 'viewer'
  return { userId: reader.userId, isAdmin: reader.isAdmin, baseline, allowedSubsidiaryIds: reader.allowedSubsidiaryIds }
}
