import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { bankingCashSpec } from "./view";
import { PageProjectionStatus } from "@/components/page-projection-status";
import { projectedPage, projectedPageParams } from "@/lib/page-projection";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("banking.cash");
  return { title: t("title") };
}

/**
 * Cash control center — whole-company liquidity off the shared cash engine.
 * Operational counterpart to analytics/cashflow: this page is where you act on
 * cash (runway, lowest point, the weekly timeline with per-week drill and the
 * forecast config); the analytics dashboard is where you explain it.
 */
export default async function BankingCashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  // The cockpit answers from its latest projection; a projection that may
  // be out of date is labelled with when it was calculated and rebuilt.
  const { data, observedAt, refreshing } = await projectedPage("banking-cash", sp);
  return (
    <>
      <ModuleView spec={bankingCashSpec(data)} data={data} searchParams={sp} trusted />
      <PageProjectionStatus
        page="banking-cash"
        params={projectedPageParams("banking-cash", sp)}
        observedAt={observedAt}
        refreshing={refreshing}
      />
    </>
  );
}
