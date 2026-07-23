import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { PageHeader } from "@openbooks/ui";
import { getTranslations } from "next-intl/server";
import { can, requirePermission } from "../../../lib/authz";
import { requireProjectsFeature } from "../../../lib/projects-gate";
import { ConstructionClient } from "./ConstructionClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("applications");
  return { title: t("title") };
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
  await requireProjectsFeature(authz.user.orgId);
  const t = await getTranslations("applications");
  const sp = await searchParams;
  const projectId = typeof sp.projectId === "string" ? sp.projectId : null;

  const [projects, incomeAccounts] = await Promise.all([
    db.execute(sql`
      select p.id, p.name, c.display_name as "customerName"
        from projects p
        left join parties c on c.id = p.customer_id and c.org_id = p.org_id
        left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
       where p.org_id = ${authz.user.orgId}
         and (
           coalesce(pt.invoicing_profile->>'billingProcedure', 'standard') = 'application_for_payment'
           or exists (select 1 from sov_lines sl where sl.org_id = p.org_id and sl.project_id = p.id)
           or exists (select 1 from pay_applications pa where pa.org_id = p.org_id and pa.project_id = p.id)
         )
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
      <PageHeader title={t("title")} description={t("description")} />
      <ConstructionClient
        projects={projects.rows.map((p) => ({ id: p.id, name: p.name, customerName: p.customerName }))}
        incomeAccounts={incomeAccounts.rows.map((a) => ({ id: a.id, label: [a.number, a.name].filter(Boolean).join(" · ") }))}
        initialProjectId={projectId}
        canCreate={can(authz, "ar.create")}
        canApprove={can(authz, "ar.approve")}
        canInvoice={can(authz, "ar.post")}
      />
    </div>
  );
}
