import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { PageHeader } from "@openbooks/ui";
import { ListPageLayout } from "../../../components/page-layout";
import { can, requirePermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { requireSubcontractsFeature } from "../../../lib/subcontracts-gate";
import { SubcontractsWorkspace } from "./SubcontractsWorkspace";

export const dynamic = "force-dynamic";

export default async function SubcontractsPage() {
  const authz = await requirePermission("ap.read");
  await requireSubcontractsFeature(authz.user.orgId);
  const orgId = authz.user.orgId;
  const multiCurrency = await isFeatureEnabled(orgId, "multiCurrency");
  const [projects, vendors, accounts, parties] = await Promise.all([
    db.execute(sql`select id, name from projects where org_id = ${orgId} and is_active and status not in ('closed','cancelled') order by name`) as any,
    multiCurrency
      ? db.execute(sql`select p.id, p.display_name as name, vr.currency from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id where p.org_id = ${orgId} and p.is_active and vr.is_active order by p.display_name`) as any
      : db.execute(sql`select p.id, p.display_name as name from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id where p.org_id = ${orgId} and p.is_active and vr.is_active order by p.display_name`) as any,
    db.execute(sql`select id, concat_ws(' · ', number, name) as name from accounts where org_id = ${orgId} and is_active and not is_summary and type in ('expense','cogs') order by number nulls last`) as any,
    db.execute(sql`select id, display_name as name from parties where org_id = ${orgId} and is_active order by display_name limit 2000`) as any,
  ]);
  return (
    <ListPageLayout
      header={<PageHeader title="Subcontracts" description="Vendor commitments, progress applications, retainage, and payment controls." />}
    >
      <SubcontractsWorkspace
        projects={projects.rows}
        vendors={vendors.rows}
        expenseAccounts={accounts.rows}
        parties={parties.rows}
        multiCurrency={multiCurrency}
        permissions={{
          create: can(authz, "ap.create"),
          approve: can(authz, "ap.approve"),
          post: can(authz, "ap.post"),
          pay: can(authz, "ap.pay"),
        }}
      />
    </ListPageLayout>
  );
}
