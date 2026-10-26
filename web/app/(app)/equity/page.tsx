import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { EquityError } from "@openbooks/engine/equity";
import { Button } from "@openbooks/ui";
import { RouteStateView } from "@/components/route-state";
import { readerRefusal } from "@/lib/reader-refusal";
import { ModuleView } from "@/components/viewspec/module-view";
import { equitySpec, loadEquity } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("equity");
  return { title: t("home.title") };
}

/**
 * Equity & cap table: the legal entity's capitalization as of a date, its
 * securities and stakeholders, plans and pools, rounds and convertibles,
 * exit waterfall and stock compensation.
 */
export default async function EquityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Only loader work sits inside the try: a named equity refusal shows its
  // message and remedy; redirects, missing records and unexpected failures
  // keep their existing handling.
  let data: Awaited<ReturnType<typeof loadEquity>>;
  try {
    data = await loadEquity(sp);
  } catch (error) {
    if (!(error instanceof EquityError)) throw error;
    const t = await getTranslations("shell.routeState");
    const refusal = await readerRefusal(error);
    return (
      <RouteStateView
        state="error"
        icon={<AlertTriangle />}
        title={refusal.message}
        description={refusal.remedy}
        action={
          <Button asChild>
            <Link href="/dashboard">{t("backToDashboard")}</Link>
          </Button>
        }
      />
    );
  }
  return <ModuleView spec={equitySpec(data)} data={data} searchParams={sp} trusted />;
}
