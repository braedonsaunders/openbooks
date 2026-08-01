import type { ReactNode } from 'react'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'

export default async function QueryConsoleLayout({ children }: { children: ReactNode }) {
  const authz = await requirePermission('sql.execute')
  await requireFeatureEnabled(authz.user.orgId, 'queryConsole')
  return children
}
