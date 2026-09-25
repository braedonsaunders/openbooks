import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { accessDeniedHref } from '../../../lib/gate-targets'

export default async function QueryConsoleLayout({ children }: { children: ReactNode }) {
  const authz = await requirePermission('sql.execute')
  await requireFeatureEnabled(authz.user.orgId, 'queryConsole')
  // Raw SQL cannot apply a subsidiary allowlist, so both query endpoints
  // refuse restricted callers — the page applies the identical fence instead
  // of admitting them to a console whose every run 403s.
  if (authz.allowedSubsidiaryIds !== null) {
    redirect(accessDeniedHref({ permission: 'unrestricted subsidiary access' }))
  }
  return children
}
