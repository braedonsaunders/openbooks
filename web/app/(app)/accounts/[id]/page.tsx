import { redirect } from 'next/navigation'
import { requirePermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Compatibility route for saved register URLs. Registers are now an in-context
 * drawer; old links are normalized to the Chart of Accounts drawer host.
 */
export default async function LegacyAccountRegister({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ page?: string; from?: string; to?: string }>
}) {
  await requirePermission('gl.read')
  const { id } = await params
  if (!isUuid(id)) redirect('/accounts')
  const sp = await searchParams
  const next = new URLSearchParams({ accountRegister: id })
  if (sp.page) next.set('accountRegisterPage', sp.page)
  if (sp.from) next.set('accountRegisterFrom', sp.from)
  if (sp.to) next.set('accountRegisterTo', sp.to)
  redirect(`/accounts?${next}`)
}
