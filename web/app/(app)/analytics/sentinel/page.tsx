import { redirect } from "next/navigation";
import { readAnalyticsDashboard } from "../../../../lib/analytics/dashboard-reader";
import { sentinelAccessDenied } from "../../../../lib/analytics/sentinel-access";
import { requirePermission } from "../../../../lib/authz";
import { accessDeniedHref } from "../../../../lib/gate-targets";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { sentinelSpec } from "./view";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("analytics.sentinel");
  return { title: t("title") };
}

export default async function SentinelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Whole-company forensics: a reader short of the Sentinel grants is sent to
  // the access-denied explanation naming the missing requirement, not an error.
  const denied = sentinelAccessDenied(await requirePermission("reports.read"));
  if (denied !== null) redirect(accessDeniedHref({ permission: denied }));
  const sp = await searchParams;
  const data = await readAnalyticsDashboard("sentinel", sp, { answerStale: true });
  return <ModuleView spec={sentinelSpec(data)} data={data} searchParams={sp} trusted />;
}
