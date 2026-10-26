import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../components/viewspec/module-view";
import { customersSpec } from "./view";
import { PageProjectionStatus } from "@/components/page-projection-status";
import { projectedPage, projectedPageParams } from "@/lib/page-projection";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("customers");
  return { title: t("home.title") };
}

/**
 * Customers module home — the relationship-to-cash workspace landing the nav
 * group header opens. The top open-balance relationships are the hero; the
 * rail carries the 13-week collections trend, the live directory, and the
 * needs-attention queue. Tabs are ROUTES (the /ap idiom): the AR cockpit
 * stays its own page and appears here as a sibling tab when the org's nav
 * shows it.
 */
export default async function CustomersHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  // The cockpit answers from its latest projection; a projection that may
  // be out of date is labelled with when it was calculated and rebuilt.
  const { data, observedAt, refreshing } = await projectedPage("customers", sp);
  return (
    <>
      <ModuleView spec={customersSpec(data)} data={data} searchParams={sp} trusted />
      <PageProjectionStatus
        page="customers"
        params={projectedPageParams("customers", sp)}
        observedAt={observedAt}
        refreshing={refreshing}
      />
    </>
  );
}
