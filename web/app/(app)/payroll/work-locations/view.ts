import "server-only";
import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { mergeHref } from "../../../../lib/list-params";

export interface WorkLocationsData {
  title: string;
  description: string;
  /** The header's primary action keeps the list's employment and period. */
  record: { href: string; label: string };
}

export async function loadWorkLocations(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<WorkLocationsData> {
  const authz = await requirePermission("payroll.manage");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "payroll");
  const t = await getTranslations("payroll.workLocations");
  return {
    title: t("title"),
    description: t("description"),
    record: {
      href: mergeHref("/payroll/work-locations", sp, { new: "1", page: undefined }),
      label: t("record"),
    },
  };
}

const f = ref<WorkLocationsData>();
export function workLocationsSpec(_data: WorkLocationsData): PageSpec {
  return page({
    route: "/payroll/work-locations",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("link-button", {
            href: f("record.href"),
            label: f("record.label"),
            iconKey: "plus",
          }),
        ],
      }),
    ],
    body: [widgetBlock("payroll-work-locations", {})],
  });
}
