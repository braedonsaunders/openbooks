import { notFound } from 'next/navigation'
import { clamp, isUuid, pickString } from '../../../../../lib/list-params'
import { platformGrantOptions, platformUser } from '../../../../../lib/platform-admin'
import { requireSuperAdmin } from '../../../../../lib/super-admin'
import { PlatformUserDetailClient } from '../../_components/PlatformUserDetailClient'

export const dynamic = 'force-dynamic'

export default async function PlatformUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const sp = await searchParams
  // The grant sub-list pages in SQL like every other operator list. The order
  // is the loader's fixed organization-then-member order, so only the page
  // and the page size travel on the URL (house clamps, page one on refusal).
  const grantsPage = clamp(Number(pickString(sp.page) ?? '1'), 1, 10_000)
  const grantsPerPage = clamp(Number(pickString(sp.perPage) ?? '25'), 5, 100)
  const authz = await requireSuperAdmin()
  const [record, options] = await Promise.all([
    platformUser(id, { page: grantsPage, perPage: grantsPerPage }),
    platformGrantOptions(),
  ])
  if (!record) notFound()
  return (
    <PlatformUserDetailClient
      user={record.user}
      grants={record.grants}
      grantsTotal={record.totalGrants}
      grantsPage={grantsPage}
      grantsPerPage={grantsPerPage}
      basePath={`/platform/users/${id}`}
      listParams={sp}
      members={options.members}
      organizations={options.organizations.filter((org) => org.id !== record.user.orgId)}
      actingUsers={options.actingUsers}
      isSelf={record.user.id === authz.user.homeUserId}
    />
  )
}
