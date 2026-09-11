import { getTranslations } from "next-intl/server"
import { ModuleView } from "../../../components/viewspec/module-view"
import { loadCollections, collectionsSpec } from "./view"

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
  const sp = await searchParams
  const data = await loadCollections()
  return <ModuleView spec={collectionsSpec(data)} data={data} searchParams={sp} trusted />
}
