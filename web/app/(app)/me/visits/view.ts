import "server-only";

import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { listMyVisits, type MyVisit } from "@openbooks/engine/service/reads";
import { ServiceError } from "@openbooks/engine/service/errors";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { getAuthz } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { accessDeniedHref } from "../../../../lib/gate-targets";
import { canAny, serviceActor } from "../../../../lib/service/authority";

/**
 * My visits: the signed-in technician's own visits for the day. The first
 * day renders server-side; the component re-reads while the page is visible.
 */
export interface MyVisitsData {
  title: string;
  description: string;
  today: string;
  initial: { personName: string; visits: MyVisit[] } | null;
  refusal: { message: string; remedy: string | null } | null;
}

export async function loadMyVisits(): Promise<MyVisitsData> {
  const { redirect } = await import("next/navigation");
  const authz = await getAuthz();
  if (!authz) return redirect("/login");
  await requireFeatureEnabled(authz.user.orgId, "serviceDispatch");
  if (!canAny(authz, ["service.self"]))
    return redirect(accessDeniedHref({ permission: "service.self" }));
  const t = await getTranslations("service");
  const today = await businessToday(authz.user.orgId);
  let initial: MyVisitsData["initial"] = null;
  let refusal: MyVisitsData["refusal"] = null;
  try {
    const result = await listMyVisits({ ...serviceActor(authz), from: today, through: today });
    initial = { personName: result.personName, visits: result.visits };
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    refusal = { message: error.message, remedy: error.remedy ?? null };
  }
  return {
    title: t("pages.myVisits.title"),
    description: t("pages.myVisits.description"),
    today,
    initial,
    refusal,
  };
}

const f = ref<MyVisitsData>();

export function myVisitsSpec(data: MyVisitsData): PageSpec {
  return page({
    route: "/me/visits",
    layout: "list",
    header: [pageHeader({ title: f("title"), description: f("description") })],
    body: [
      widgetBlock("service-my-visits", {
        today: data.today,
        initial: data.initial,
        refusal: data.refusal,
      }),
    ],
  });
}
