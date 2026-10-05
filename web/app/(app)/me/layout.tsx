import type { Metadata } from 'next'

export const metadata: Metadata = {
  appleWebApp: { capable: true, title: 'OpenBooks', statusBarStyle: 'default' },
  icons: { apple: '/employee-app/apple-touch-icon.png' },
}

export default function EmployeeLayout({ children }: { children: React.ReactNode }) {
  return children
}
