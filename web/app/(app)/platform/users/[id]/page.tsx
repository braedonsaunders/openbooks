import { notFound } from 'next/navigation'
import { isUuid } from '../../../../../lib/list-params'
import { platformGrantOptions, platformUser } from '../../../../../lib/platform-admin'
import { requireSuperAdmin } from '../../../../../lib/super-admin'
import { PlatformUserDetailClient } from '../../_components/PlatformUserDetailClient'

export const dynamic = 'force-dynamic'

export default async function PlatformUserPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const authz = await requireSuperAdmin()
  const [record, options] = await Promise.all([platformUser(id), platformGrantOptions()])
  if (!record) notFound()
  return (
    <PlatformUserDetailClient
      user={record.user}
      grants={record.grants}
      members={options.members}
      organizations={options.organizations.filter((org) => org.id !== record.user.orgId)}
      actingUsers={options.actingUsers}
      isSelf={record.user.id === authz.user.homeUserId}
    />
  )
}
