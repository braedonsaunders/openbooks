import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// Company & Accounting settings moved into the Setup workspace. Keep the old
// URL working for bookmarks and in-app links.
export default function CompanySettingsRedirect() {
  redirect('/admin/setup/company')
}
