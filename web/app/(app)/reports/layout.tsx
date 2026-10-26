/**
 * Reports layout. Report transactions open their native record drawer over the
 * current page through the shell-level report drawer host (see TxnLink), so
 * there is no reports-only overlay to mount here.
 */
import { requirePermission } from "../../../lib/authz";

export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("reports.read");

  return <>{children}</>;
}
