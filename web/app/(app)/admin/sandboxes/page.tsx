import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@openbooks/ui";
import { db } from "@openbooks/engine/src/db.ts";
import { listSandboxes } from "@openbooks/engine/src/sandbox/index.ts";
import { ListPageLayout } from "../../../../components/page-layout";
import { requirePermission } from "../../../../lib/authz";
import { SandboxManager, type SandboxRow, type PeriodOption } from "./SandboxManager";

export const dynamic = "force-dynamic";

export default async function SandboxesPage() {
  const authz = await requirePermission("admin.sandboxes.manage");
  const tHub = await getTranslations("admin.hub");
  // Always manage sandboxes against the home production org.
  const rows = (await listSandboxes(authz.user.productionOrgId)) as unknown as SandboxRow[];

  // Accounting periods for the as-of clone cutoff (most recent first).
  const periodsRes = (await db.execute(sql`
    select id, name from accounting_periods
     where org_id = ${authz.user.productionOrgId}
     order by fiscal_year desc, period_number desc
     limit 240`)) as unknown as { rows: PeriodOption[] };

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: "/admin", label: tHub("title") }}
          title="Environments"
          description="Create and manage sandbox copies of your production books — instant to clone, isolated, refreshable, and promotable back to production."
        />
      }
    >
      {authz.user.envKind !== "production" ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          You are currently inside a sandbox. Exit to production to manage environments.
        </p>
      ) : (
        <SandboxManager sandboxes={rows} periods={periodsRes.rows} />
      )}
    </ListPageLayout>
  );
}
