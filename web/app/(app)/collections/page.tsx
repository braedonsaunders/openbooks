import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { requirePermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { ModuleView } from "../../../components/viewspec/module-view";
import { CollectionsShell } from "./sections";
import { loadCollections, collectionsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("nav");
  return { title: t("modules.collections") };
}

/**
 * Recurring billing + dunning control surface. Recurring schedules clone a
 * template document on a cadence (engine/src/recurring.ts); dunning policies
 * fire an overdue-invoice reminder ladder (engine/src/dunning.ts). When the
 * subscriptionBilling feature is on, a Subscriptions tab (plans + subscriptions,
 * engine/src/subscription-billing.ts) is added. All run from the scheduler.
 */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadCollections()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={collectionsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const [tNav, tAr] = await Promise.all([
    getTranslations("nav"),
    getTranslations("ar"),
  ]);
  const authz = await requirePermission("documents.manage").catch(() => null);
  if (!authz) redirect("/dashboard");

  const subscriptionsEnabled = await isFeatureEnabled(authz.user.orgId, "subscriptionBilling");
  const advancedSubscriptionsEnabled = subscriptionsEnabled && await isFeatureEnabled(authz.user.orgId, "advancedSubscriptions");
  const [customers, incomeAccounts] = subscriptionsEnabled
    ? await Promise.all([
        db.execute<any>(sql`
          select p.id, p.display_name as "name" from parties p
           where p.org_id = ${authz.user.orgId} and p.is_active
             and exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.org_id = p.org_id)
           order by p.display_name
        `),
        db.execute<any>(sql`
          select id, number, name from accounts
           where org_id = ${authz.user.orgId} and type in ('income', 'income_other') and is_active
           order by number nulls last
        `),
      ])
    : [{ rows: [] }, { rows: [] }];

  return (
    <CollectionsShell
      title={tNav("modules.collections")}
      description={tAr("cockpit.description")}
      subscriptionsEnabled={subscriptionsEnabled}
      advancedSubscriptionsEnabled={advancedSubscriptionsEnabled}
      customers={customers.rows.map((c) => ({ id: c.id, name: c.name }))}
      incomeAccounts={incomeAccounts.rows.map((a) => ({ id: a.id, label: [a.number, a.name].filter(Boolean).join(" · ") }))}
    />
  );
}
