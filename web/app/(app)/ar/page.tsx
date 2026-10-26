import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../components/viewspec/module-view";
import { arCockpitSpec } from "./view";
import { PageProjectionStatus } from "@/components/page-projection-status";
import { projectedPage, projectedPageParams } from "@/lib/page-projection";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("ar");
  return { title: t("cockpit.title") };
}

/**
 * Accounts Receivable — the receivables control center (vitals + collections
 * worklist + aging), the AP page's mirror. The invoice list is its own
 * first-class route at /ar/invoices.
 */
// The whole props object is optional: an integration test renders this page
// component directly with no arguments, and a bare destructure would make
// that a type error.
export default async function AR({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp0 = (await searchParams) ?? {};
  // The cockpit answers from its latest projection; a projection that may
  // be out of date is labelled with when it was calculated and rebuilt.
  const { data, observedAt, refreshing } = await projectedPage("ar", sp0);
  return (
    <>
      <ModuleView spec={arCockpitSpec(data)} data={data} searchParams={sp0} trusted />
      <PageProjectionStatus
        page="ar"
        params={projectedPageParams("ar", sp0)}
        observedAt={observedAt}
        refreshing={refreshing}
      />
    </>
  );
}
