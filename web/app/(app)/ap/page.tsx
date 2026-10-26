import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../components/viewspec/module-view";
import { apCockpitSpec } from "./view";
import { PageProjectionStatus } from "@/components/page-projection-status";
import { projectedPage, projectedPageParams } from "@/lib/page-projection";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("ap");
  return { title: t("cockpit.title") };
}

/**
 * Accounts Payable — the payables control center (vitals + pay-run planner +
 * aging). The bills list is its own first-class route at /ap/bills.
 */
// `searchParams` is OPTIONAL because cash-scope.integration.test.ts calls
// this component directly with no arguments — the same accommodation /ar
// needed. A required prop here turns a passing test into a type error.
export default async function AP({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // The cockpit answers from its latest projection; a projection that may
  // be out of date is labelled with when it was calculated and rebuilt.
  const { data, observedAt, refreshing } = await projectedPage("ap", sp);
  return (
    <>
      <ModuleView spec={apCockpitSpec(data)} data={data} searchParams={sp} trusted />
      <PageProjectionStatus
        page="ap"
        params={projectedPageParams("ap", sp)}
        observedAt={observedAt}
        refreshing={refreshing}
      />
    </>
  );
}
