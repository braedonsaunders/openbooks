import { redirect } from 'next/navigation'
import { requirePermission } from '../../../../lib/authz'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Legacy authoring links resolve to the extension's one management entry. */
export default async function AppsAdminPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('apps.manage')
  const sp = await searchParams
  const params = new URLSearchParams()
  for (const key of ['q', 'status', 'page'] as const) if (typeof sp[key] === 'string') params.set(key, sp[key])
  if (typeof sp.app === 'string') params.set('module', sp.app)
  if (sp.new === '1') params.set('new', '1')
  redirect(`/admin/modules${params.size ? '?' + params.toString() : ''}`)
}
