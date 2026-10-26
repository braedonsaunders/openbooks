import "server-only";

import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { getTranslations } from "next-intl/server";
import { guardUnrestrictedScope, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { taxWorkspaceTabs } from "../workspace-tabs";
import { forbidden } from "next/navigation";

export interface OssData {
  setupHref: string;
  title: string;
  description: string;
  tabs: ModuleHomeTab[];
}

/**
 * One-Stop-Shop returns: quarterly Union/non-Union and monthly IOSS returns
 * from posted cross-border supplies. Gated page (reports read plus the
 * crossBorderTax feature); the console prepares, reviews and exports.
 */
export async function loadOss(): Promise<OssData> {
  const authz = await requirePermission("reports.read");
  if (guardUnrestrictedScope(authz)) forbidden();
  await requireFeatureEnabled(authz.user.orgId, "crossBorderTax");
  const [t, tabs] = await Promise.all([
    getTranslations("tax.oss"),
    taxWorkspaceTabs(authz.user.orgId, "oss"),
  ]);
  return {
    setupHref: "/admin/setup/tax-oss-registrations",
    title: t("title"),
    description: t("description"),
    tabs,
  };
}

const f = ref<OssData>();

export function ossSpec(data: OssData): PageSpec {
  return page({
    route: "/tax/oss",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [widget("module-home-tabs", { tabs: f("tabs") })],
      }),
    ],
    body: [widgetBlock("oss-console", { setupHref: data.setupHref })],
  });
}
