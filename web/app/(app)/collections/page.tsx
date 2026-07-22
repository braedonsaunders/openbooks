import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { PageHeader } from "@openbooks/ui";
import { requirePermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { CollectionsClient } from "./CollectionsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: "Recurring & Collections" };
}

/**
 * Recurring billing + dunning control surface. Recurring schedules clone a
 * template document on a cadence (engine/src/recurring.ts); dunning policies
 * fire an overdue-invoice reminder ladder (engine/src/dunning.ts). When the
 * subscriptionBilling feature is on, a Subscriptions tab (plans + subscriptions,
 * engine/src/subscription-billing.ts) is added. All run from the scheduler.
 */
export default async function CollectionsPage() {
  const authz = await requirePermission("documents.manage").catch(() => null);
  if (!authz) redirect("/dashboard");

  const subscriptionsEnabled = await isFeatureEnabled(authz.user.orgId, "subscriptionBilling");
  const [customers, incomeAccounts] = subscriptionsEnabled
    ? await Promise.all([
        db.execute(sql`
          select p.id, p.display_name as "name" from parties p
           where p.org_id = ${authz.user.orgId} and p.is_active
             and exists (select 1 from customer_roles cr where cr.party_id = p.id)
           order by p.display_name
        `) as unknown as Promise<{ rows: any[] }>,
        db.execute(sql`
          select id, number, name from accounts
           where org_id = ${authz.user.orgId} and type in ('income', 'income_other') and is_active
           order by number nulls last
        `) as unknown as Promise<{ rows: any[] }>,
      ])
    : [{ rows: [] }, { rows: [] }];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <PageHeader
        title="Recurring & Collections"
        description="Automate repeating invoices and chase overdue receivables."
      />
      <CollectionsClient
        subscriptionsEnabled={subscriptionsEnabled}
        customers={customers.rows.map((c) => ({ id: c.id, name: c.name }))}
        incomeAccounts={incomeAccounts.rows.map((a) => ({ id: a.id, label: [a.number, a.name].filter(Boolean).join(" · ") }))}
      />
    </div>
  );
}
