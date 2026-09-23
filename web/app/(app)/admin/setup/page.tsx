import { redirect } from 'next/navigation'
import { movedUrl } from '../../../../lib/moved-redirect'

export const dynamic = 'force-dynamic'

// The Setup landing is the guided go-live workspace. Deep configuration stays
// available in the rail, but a fresh company should never have to infer its
// setup order from dozens of tables. Name the destination on arrival, via
// ?movedFrom=setup-index, instead of landing silently.
export default async function SetupIndexPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  redirect(movedUrl('/admin/setup/readiness', 'setup-index', sp))
}
