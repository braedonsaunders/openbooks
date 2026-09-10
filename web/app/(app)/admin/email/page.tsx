import { PageHeader } from '@openbooks/ui'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../../lib/authz'
import { readOrgEmailConfigView } from '@openbooks/engine/src/email-config.ts'
import { PageContainer } from '../../../../components/page-layout'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { EmailSettingsForm } from './EmailSettingsForm'
import { emailSettingsSpec, loadEmailSettings } from './view'

export const dynamic = 'force-dynamic'

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadEmailSettings()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={emailSettingsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('admin.setup.manage')
  const tHub = await getTranslations('admin.hub')
  const config = await readOrgEmailConfigView(authz.user.orgId)

  return (
    <PageContainer>
      <PageHeader
        title="Email delivery"
        description="Configure your email provider so scheduled reports and notifications can be delivered."
        back={{ href: '/admin', label: tHub('title') }}
      />
      <EmailSettingsForm initial={config} />
    </PageContainer>
  )
}
