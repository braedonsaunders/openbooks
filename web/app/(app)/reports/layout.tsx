/**
 * Reports layout. Report transactions open their REAL native flyout via the
 * owning module (see TxnLink → `/ap?doc=`, `/journal?entry=`, …), so there is no
 * reports-only overlay to mount here.
 */
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
