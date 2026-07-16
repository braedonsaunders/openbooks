import { PageHeader } from '@openbooks/ui'
import { requirePermission } from '../../../../lib/authz'
import { readOrgEmailConfigView } from '@openbooks/engine/src/email-config.ts'
import { PageContainer } from '../../../../components/page-layout'
import { EmailSettingsForm } from './EmailSettingsForm'

export const dynamic = 'force-dynamic'

export default async function EmailSettingsPage() {
  const authz = await requirePermission('admin.users.manage')
  const config = await readOrgEmailConfigView(authz.user.orgId)

  return (
    <PageContainer>
      <PageHeader
        title="Email delivery"
        description="Configure your email provider so scheduled reports and notifications can be delivered."
        back={{ href: '/admin', label: 'Admin' }}
      />
      <EmailSettingsForm initial={config} />
    </PageContainer>
  )
}
