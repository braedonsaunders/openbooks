import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// /dashboard is the one canonical home (UX-17): the root dashboard and the
// dashboard route rendered byte-identical pages, so the brand, the nav and
// every gate named two homes. Keep this route working for bookmarks by
// sending it to the canonical one. The loader/spec pair in ./view.ts stays
// the page-registry's record for this route.
export default function Home() {
  redirect('/dashboard')
}
