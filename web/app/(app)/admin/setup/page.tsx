import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// The Setup landing has no content of its own — open the Company tab.
export default function SetupIndexPage() {
  redirect('/admin/setup/company')
}
