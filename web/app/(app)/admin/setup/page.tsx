import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// The Setup landing is the guided go-live workspace. Deep configuration stays
// available in the rail, but a fresh company should never have to infer its
// setup order from dozens of tables.
export default function SetupIndexPage() {
  redirect('/admin/setup/readiness')
}
