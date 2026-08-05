/**
 * Reports layout. Report transactions open their REAL native flyout via the
 * owning module (see TxnLink → `/ap/bills?doc=`, `/journal?entry=`, …), so there is no
 * reports-only overlay to mount here.
 */
import { requirePermission } from '../../../lib/authz'

export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('reports.read')

  return <>{children}</>
}
