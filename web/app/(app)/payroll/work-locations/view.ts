import "server-only";
import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";

export interface WorkLocationsData {
  title: string;
  description: string;
  canManage: boolean;
}

export async function loadWorkLocations(): Promise<WorkLocationsData> {
  const authz = await requirePermission("payroll.manage");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "payroll");
  const t = await getTranslations("payroll");
  const text = (key: string, fallback: string) =>
    t.has(key as never) ? t(key as never) : fallback;
  return {
    title: text("workLocations.title", "Payroll work locations"),
    description: text(
      "workLocations.description",
      "Record work-location evidence for employments without approved dated time entries. Committed payroll periods are locked.",
    ),
    canManage: true,
  };
}

const f = ref<WorkLocationsData>();
export function workLocationsSpec(_data: WorkLocationsData): PageSpec {
  return page({
    route: "/payroll/work-locations",
    layout: "list",
    header: [pageHeader({ title: f("title"), description: f("description") })],
    body: [widgetBlock("payroll-work-locations", {})],
  });
}
