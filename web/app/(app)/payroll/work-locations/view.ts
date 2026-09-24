import "server-only";
import { getTranslations } from "next-intl/server";
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { groupTabs } from "../../../../components/module-home/group-tabs";

export interface WorkLocationsData {
  title: string;
  description: string;
  viewTabs: { href: string; label: string; active?: boolean }[];
  canManage: boolean;
}

export async function loadWorkLocations(): Promise<WorkLocationsData> {
  const authz = await requirePermission("payroll.manage");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "payroll");
  const t = await getTranslations("payroll");
  const text = (key: string, fallback: string) => t.has(key as never) ? t(key as never) : fallback;
  return {
    title: text("workLocations.title", "Payroll work locations"),
    description: text("workLocations.description", "Record work-location evidence for employments without approved dated time entries. Committed payroll periods are locked."),
    viewTabs: await groupTabs("payroll", "/payroll/work-locations", { orgId }),
    canManage: true,
  };
}

const f = ref<WorkLocationsData>();
export function workLocationsSpec(data: WorkLocationsData): PageSpec {
  return page({
    route: "/payroll/work-locations",
    layout: "list",
    header: [pageHeader({ title: f("title"), description: f("description"), actions: [widget("module-home-tabs", { tabs: data.viewTabs })] })],
    body: [widgetBlock("payroll-work-locations", {})],
  });
}
