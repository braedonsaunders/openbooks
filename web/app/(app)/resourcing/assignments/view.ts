import "server-only";
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { weekStartOf } from "@openbooks/engine/src/resourcing/weeks.ts";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { isUuid, pickString } from "../../../../lib/list-params";
import { loadAssignmentDrawerData, type AssignmentDrawerData } from "../../../../lib/resourcing/assignment-drawer";

export type ResourcingAssignmentsPageData = {
  title: string;
  description: string;
  newLabel: string;
  currentParams: Record<string, string | string[] | undefined>;
  canManage: boolean;
  drawer: (AssignmentDrawerData & { remountKey: string; closeHref: string }) | {
    notFound: true;
    remountKey: string;
    closeHref: string;
  } | null;
};

export async function loadResourcingAssignmentsPage(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<ResourcingAssignmentsPageData> {
  const authz = await requirePermission("resourcing.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "resourcing");
  const { getTranslations } = await import("next-intl/server");
  const t = await getTranslations("resourcing");
  const canManage = can(authz, "resourcing.manage");
  const assignmentParam = pickString(searchParams.assignment);
  let drawer: ResourcingAssignmentsPageData["drawer"] = null;
  if (assignmentParam === "new" && canManage) {
    const currentSunday = weekStartOf(await businessToday(orgId));
    const resolved = await loadAssignmentDrawerData({
      orgId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      assignmentId: null,
      createMode: true,
      prefill: {
        projectId: "",
        employeePartyId: "",
        jobTitle: "",
        weekStart: currentSunday,
        plannedHours: "8.0000",
      },
    });
    if (resolved) drawer = { ...resolved, remountKey: "new", closeHref: "/resourcing/assignments" };
  } else if (assignmentParam && isUuid(assignmentParam)) {
    const resolved = await loadAssignmentDrawerData({
      orgId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      assignmentId: assignmentParam,
    });
    drawer = resolved
      ? { ...resolved, remountKey: assignmentParam, closeHref: "/resourcing/assignments" }
      : { notFound: true, remountKey: assignmentParam, closeHref: "/resourcing/assignments" };
  }

  return {
    title: t("assignments.title"),
    description: t("assignments.description"),
    newLabel: t("assignments.new"),
    currentParams: searchParams,
    canManage,
    drawer,
  };
}

const f = ref<ResourcingAssignmentsPageData>();

export function resourcingAssignmentsSpec(data: ResourcingAssignmentsPageData): PageSpec {
  return page({
    route: "/resourcing/assignments",
    layout: "list",
    header: [pageHeader({
      title: f("title"),
      description: f("description"),
      actions: [widget("link-button", { href: "/resourcing/assignments?assignment=new", label: data.newLabel, variant: "outline" }, f("canManage"))],
    })],
    body: [widgetBlock("entity-list-view", {
      recordType: "resourcing_assignment",
      sp: data.currentParams,
      drawer: data.drawer ? { widget: "resourcing-assignment-drawer", props: { drawer: data.drawer, canManage: data.canManage } } : null,
      emptyAction: data.canManage
        ? { widget: "link-button", props: { href: "/resourcing/assignments?assignment=new", label: data.newLabel } }
        : null,
    })],
  });
}
