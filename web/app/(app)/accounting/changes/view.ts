import "server-only";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
  type WidgetRef,
} from "@braedonsaunders/appkit-viewspec";
import { getAuthz, can } from "../../../../lib/authz";
import { accessDeniedHref } from "../../../../lib/gate-targets";
import { isFeatureEnabled } from "../../../../lib/features";
import {
  canShowNetInvestmentOciReversal,
  changeAuthority,
  enabledAccountingChangeDomains,
  type AccountingChangeDomain,
  type AccountingChangeFeature,
  type AccountingChangeFeatureState,
} from "../../../../lib/accounting-change-authority";
import { groupTabs } from "../../../../components/module-home/group-tabs";

type AccountingChangesAuthz = NonNullable<Awaited<ReturnType<typeof getAuthz>>>;

export interface AccountingChangesWorkspaceData {
  auth: AccountingChangesAuthz;
  domains: AccountingChangeDomain[];
  allowNetInvestmentOciReversal: boolean;
  sp: Record<string, string | string[] | undefined>;
}

export interface AccountingChangesData {
  title: string;
  description: string;
  tabs: Awaited<ReturnType<typeof groupTabs>>;
  workspace: AccountingChangesWorkspaceData;
}

export async function loadAccountingChanges(
  sp: Record<string, string | string[] | undefined>,
): Promise<AccountingChangesData> {
  const auth = await getAuthz();
  if (!auth) redirect("/login");
  const candidates: AccountingChangeDomain[] = [];
  if (can(auth, "gl.read")) {
    candidates.push("lease", "asset", "revenue", "consolidation", "provision", "sales");
  } else {
    if (can(auth, "assets.read")) candidates.push("lease", "asset");
    if (can(auth, "ar.read")) candidates.push("revenue", "sales");
    if (can(auth, "close.read")) candidates.push("consolidation");
  }
  if (can(auth, "payroll.read")) candidates.push("payroll");
  if (can(auth, "manufacturing.read")) candidates.push("manufacturing");
  const features: AccountingChangeFeatureState = {};
  const requiredFeatures = [
    ...new Set(
      candidates
        .map((domain) => changeAuthority[domain].feature)
        .filter((feature): feature is AccountingChangeFeature => feature !== null),
    ),
  ];
  await Promise.all(
    requiredFeatures.map(async (feature) => {
      features[feature] = await isFeatureEnabled(auth.user.orgId, feature);
    }),
  );
  const domains = enabledAccountingChangeDomains(candidates, features);
  const allowNetInvestmentOciReversal = canShowNetInvestmentOciReversal(candidates, features);
  if (domains.length === 0 && !allowNetInvestmentOciReversal)
    redirect(accessDeniedHref({ permission: "gl.read" }));
  const t = await getTranslations("accounting");
  const tabs = await groupTabs("accounting", "/accounting/changes", { orgId: auth.user.orgId });
  return {
    title: t("lifecycle.pageTitle"),
    description: t("lifecycle.pageDescription"),
    tabs,
    workspace: { auth, domains, allowNetInvestmentOciReversal, sp },
  };
}

const f = ref<AccountingChangesData>();

export function accountingChangesSpec(_data: AccountingChangesData): PageSpec {
  const actions: WidgetRef[] = [widget("module-home-tabs", { tabs: f("tabs") })];
  return page({
    route: "/accounting/changes",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions,
      }),
    ],
    body: [widgetBlock("accounting-changes-workspace", { data: f("workspace") })],
  });
}
