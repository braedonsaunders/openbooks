import { requirePermission } from '../../../../lib/authz'
import { ImportWizard } from './ImportWizard'

export default async function DataImportPage() {
  await requirePermission('data.import')
  return <ImportWizard />
}
