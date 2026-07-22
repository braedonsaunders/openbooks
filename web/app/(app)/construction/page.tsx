import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { PageHeader } from "@openbooks/ui";
import { requirePermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { ConstructionClient } from "./ConstructionClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: "Progress Billing" };
}

/**
 * Construction progress billing (AIA G702/G703): schedule of values, change
 * orders, applications for payment with retainage withheld, and retainage
 * release — for a selected project.
 */
export default async function ConstructionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requirePermission("ar.read").catch(() => null);
  if (!authz) redirect("/dashboard");
  if (!(await isFeatureEnabled(authz.user.orgId, "constructionBilling"))) redirect("/admin/setup/features");
  const sp = await searchParams;
  const projectId = typeof sp.projectId === "string" ? sp.projectId : null;

  const [projects, incomeAccounts] = await Promise.all([
    db.execute(sql`
      select p.id, p.name, c.display_name as "customerName"
        from projects p
        left join parties c on c.id = p.customer_id and c.org_id = p.org_id
       where p.org_id = ${authz.user.orgId}
       order by p.name
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${authz.user.orgId} and type in ('income', 'income_other') and is_active
       order by number nulls last
    `) as unknown as Promise<{ rows: any[] }>,
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <PageHeader title="Progress Billing" description="AIA schedule of values, applications for payment, and retainage." />
      <ConstructionClient
        projects={projects.rows.map((p) => ({ id: p.id, name: p.name, customerName: p.customerName }))}
        incomeAccounts={incomeAccounts.rows.map((a) => ({ id: a.id, label: [a.number, a.name].filter(Boolean).join(" · ") }))}
        initialProjectId={projectId}
      />
    </div>
  );
}
