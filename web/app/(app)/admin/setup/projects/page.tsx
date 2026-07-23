import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/** Backward-compatible redirect for saved links to the removed landing page. */
export default function ProjectsSettingsRedirect() {
  redirect('/admin/setup/features')
}
