import { ModuleView } from "@/components/viewspec/module-view";
import { loadTimesheets, timesheetsSpec } from "../../timesheets/view";
import { getAuthz, can } from "@/lib/authz";
import { getTranslations } from "next-intl/server";
import { manufacturingFeatureEnabled } from "@openbooks/engine/manufacturing/gate";
import { timeCommandGrants } from "@/lib/time-workspace";
import {
  manufacturingModuleTabs,
  type ManufacturingTabLabels,
} from "@/lib/module-home/manufacturing-tabs";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function ProductionTime({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadTimesheets(sp, "production");
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  const [nav, genealogy] = await Promise.all([
    getTranslations("nav"),
    getTranslations("manufacturing.genealogy"),
  ]);
  const labels: ManufacturingTabLabels = {
    home: nav("manufacturing"),
    "work-orders": nav("manufacturing-work-orders"),
    "work-centers": nav("manufacturing-work-centers"),
    routings: nav("manufacturing-routings"),
    mrp: nav("manufacturing-mrp"),
    quality: nav("manufacturing-quality"),
    genealogy: genealogy("title"),
    time: nav("manufacturing-time"),
  };
  const grants = timeCommandGrants("time.read");
  const mrpEnabled = await manufacturingFeatureEnabled(authz.user.orgId, "manufacturingMrp");
  const tabs: ModuleHomeTab[] = manufacturingModuleTabs("time", labels, {
    mrp: mrpEnabled,
    quality: can(authz, "items.read"),
    genealogy: can(authz, "items.read"),
    time: [...grants.all, ...grants.own].some((permission) => can(authz, permission)),
    subsidiaryId: typeof sp.sub === "string" ? sp.sub : undefined,
  });
  return <ModuleView spec={timesheetsSpec(data, tabs)} data={data} searchParams={sp} trusted />;
}
