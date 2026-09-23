import { redirect } from 'next/navigation'
import { movedUrl } from '../../../../lib/moved-redirect'

export const dynamic = 'force-dynamic'

// Company & Accounting settings moved into the Setup workspace. Keep the old
// URL working for bookmarks and in-app links — and say so on arrival, via
// ?movedFrom=settings, instead of landing silently.
export default async function CompanySettingsRedirect({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  redirect(movedUrl('/admin/setup/company', 'settings', sp))
}
