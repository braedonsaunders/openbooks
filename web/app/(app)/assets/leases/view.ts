import "server-only";

import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { allowedSubsidiaryIds, subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { isUuid, mergeHref } from "@/lib/list-params";
import { loadAssetWorkspaceTabs } from "../tabs-loader";
import { loadLease, type LeasePayload } from "./_lib";

type Option = { value: string; label: string };

export interface LeasesData {
  title: string;
  description: string;
  eventsLabel: string;
  tabs: { key: string; href: string; label: string; active: boolean }[];
  currentParams: Record<string, string | string[] | undefined>;
  canManage: boolean;
  accounts: Option[];
  subsidiaries: Option[];
  drawer: {
    remountKey: string;
    payload: LeasePayload;
    canManage: boolean;
    accounts: Option[];
    subsidiaries: Option[];
    closeHref: string;
  } | null;
}

export async function loadLeasesPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<LeasesData> {
  const auth = await requirePermission("assets.read");
  const orgId = auth.user.orgId;
  await requireFeatureEnabled(orgId, "fixedAssets");
  const allowed = await allowedSubsidiaryIds(auth.user.id, orgId);
  const [accounts, subsidiaries, payload, t] = await Promise.all([
    db.execute<Option>(
      sql`select id as value,number||' · '||name as label from accounts where org_id=${orgId} and is_active and not is_summary order by number`,
      "objects",
    ),
    db.execute<Option>(
      sql`select id as value,name as label from subsidiaries s where org_id=${orgId} and is_active and not is_elimination ${subsidiaryVisibleFilter(sql`s.id`, allowed)} order by name`,
      "objects",
    ),
    typeof sp.lease === "string" && isUuid(sp.lease)
      ? loadLease(orgId, sp.lease, allowed)
      : Promise.resolve(null),
    getTranslations("assets"),
  ]);
  const canManage = can(auth, "assets.manage");
  return {
    title: t("leases.pageTitle"),
    description: t("leases.pageDescription"),
    eventsLabel: t("leases.eventsTitle"),
    tabs: await loadAssetWorkspaceTabs(orgId, "leases", {
      register: t("tabs.register"),
      taxDepreciation: t("tabs.taxDepreciation"),
      equipment: t("equipment.title"),
      proposals: t("proposals.title"),
      construction: t("construction.title"),
      leases: t("leases.pageTitle"),
      maintenance: t("maintenance.title"),
      insurance: t("insurance.title"),
    }),
    currentParams: sp,
    canManage,
    accounts,
    subsidiaries,
    drawer: payload
      ? {
          remountKey: payload.lease.id,
          payload,
          canManage,
          accounts,
          subsidiaries,
          closeHref: mergeHref("/assets/leases", sp, { lease: undefined }),
        }
      : null,
  };
}

const f = ref<LeasesData>();

export function leasesSpec(data: LeasesData): PageSpec {
  const drawer = data.drawer
    ? { widget: "asset-lease-drawer", props: { drawer: data.drawer } }
    : null;
  return page({
    route: "/assets/leases",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center justify-end gap-2",
        actions: [
          widget(
            "asset-new-lease-button",
            { accounts: data.accounts, subsidiaries: data.subsidiaries },
            f("canManage"),
          ),
          widget("link-button", {
            href: "/accounting/changes",
            label: data.eventsLabel,
            variant: "outline",
          }),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock("entity-list-view", {
        recordType: "lease_agreement",
        sp: data.currentParams,
        drawer,
      }),
    ],
  });
}
