import { requirePermission } from '../../../../../lib/authz'
import { loadPickers } from '../../../../api/timesheets/_lib'
import { LaborRateTest } from './LaborRateTest'

export const dynamic = 'force-dynamic'

export default async function LaborRateTestPage() {
  const { user } = await requirePermission('admin.setup.manage')
  return <LaborRateTest pickers={await loadPickers(user.orgId)} />
}
