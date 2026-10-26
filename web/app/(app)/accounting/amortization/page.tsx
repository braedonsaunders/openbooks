import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { AmortizationError } from "@openbooks/engine/amortization";
import { Button } from "@openbooks/ui";
import { RouteStateView } from "@/components/route-state";
import { ModuleView } from "@/components/viewspec/module-view";
import { loadAmortization, amortizationSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function Amortization({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Only loader work sits inside the try: a named amortization refusal shows
  // its message and remedy; redirects, missing records and unexpected
  // failures keep their existing handling.
  let data: Awaited<ReturnType<typeof loadAmortization>>;
  try {
    data = await loadAmortization(sp);
  } catch (error) {
    if (!(error instanceof AmortizationError)) throw error;
    const t = await getTranslations("shell.routeState");
    return (
      <RouteStateView
        state="error"
        icon={<AlertTriangle />}
        title={error.message}
        description={error.remedy}
        action={
          <Button asChild>
            <Link href="/dashboard">{t("backToDashboard")}</Link>
          </Button>
        }
      />
    );
  }
  return <ModuleView spec={amortizationSpec(data)} data={data} searchParams={sp} trusted />;
}
