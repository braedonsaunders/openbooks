import "server-only";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { employeeRoles, resAssignments, resRequests, projects, parties, items } from "@openbooks/schema";
import { add, cmp } from "@openbooks/engine/src/money/money.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { buildResourcingForecast, type ForecastWindow } from "@openbooks/engine/src/resourcing/forecast.ts";
import { readAvailability } from "@openbooks/engine/src/resourcing/availability-read.ts";
import { weeksBetween } from "@openbooks/engine/src/resourcing/weeks.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { loadFieldDefs } from "../../../../lib/custom-fields";
import { resolveFormLayout } from "../../../../lib/customization/resolve";
import { isUuid, mergeHref, pickString } from "../../../../lib/list-params";
import { subsidiaryVisibleFilter } from "../../../../lib/subsidiaries";
import type { FormLayoutConfig } from "@openbooks/customization";
import type { CustomFieldDefClient } from "../../../../components/custom-field-inputs";

type RequestRow = typeof resRequests.$inferSelect;
type RequestRecord = Pick<RequestRow,
  "id" | "projectId" | "employeePartyId" | "jobTitle" | "firstWeek" | "lastWeek" |
  "hoursPerWeek" | "isBillable" | "billItemId" | "reason" | "status" | "decisionComment" | "custom"
>;

export type RequestWeekPreview = {
  weekStart: string;
  requestedHours: string;
  hardHours: string | null;
  netCapacity: string | null;
  overallocated: boolean | null;
};

export type RequestDrawerData = {
  remountKey: string;
  request: RequestRecord | null;
  projectName: string | null;
  employeeName: string | null;
  billItemName: string | null;
  projects: { id: string; name: string }[];
  employees: { id: string; name: string }[];
  billItems: { id: string; name: string }[];
  headerDefs: CustomFieldDefClient[];
  canManage: boolean;
  createMode: boolean;
  closeHref: string;
  layout: FormLayoutConfig;
  weeks: RequestWeekPreview[];
};

export type ResourceRequestsData = {
  title: string;
  description: string;
  newRequestLabel: string;
  currentParams: Record<string, string | string[] | undefined>;
  canManage: boolean;
  drawer: RequestDrawerData | null;
};

export async function loadResourceRequestsPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<ResourceRequestsData> {
  const [t] = await Promise.all([getTranslations("resourcing.requests")]);
  const authz = await requirePermission("resourcing.read");
  await requireFeatureEnabled(authz.user.orgId, "resourceRequests");
  const canManage = can(authz, "resourcing.manage");
  const requested = pickString(sp.request);
  const createMode = requested === "new";
  if (createMode && !canManage) notFound();
  if (requested && !createMode && !isUuid(requested)) notFound();

  const loaded = requested && !createMode
    ? await db.select({
        request: resRequests,
        projectName: projects.name,
        employeeName: parties.displayName,
        billItemName: items.name,
      }).from(resRequests)
      .innerJoin(projects, and(
        eq(projects.orgId, resRequests.orgId),
        eq(projects.id, resRequests.projectId),
      ))
      .leftJoin(parties, and(
        eq(parties.orgId, resRequests.orgId),
        eq(parties.id, resRequests.employeePartyId),
      ))
      .leftJoin(items, and(
        eq(items.orgId, resRequests.orgId),
        eq(items.id, resRequests.billItemId),
      ))
      .where(sql`${and(
        eq(resRequests.orgId, authz.user.orgId),
        eq(resRequests.id, requested),
      )}${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, authz.allowedSubsidiaryIds)}`).limit(1).then((rows) => rows[0] ?? null)
    : null;
  if (requested && !createMode && !loaded) notFound();

  const request = loaded?.request ?? null;
  const editable = createMode || (request?.status === "draft" && canManage);
  const [projectsResult, employeeRows, itemsResult] = editable
    ? await Promise.all([
        db.select({ id: projects.id, name: projects.name }).from(projects)
          .where(sql`${and(
            eq(projects.orgId, authz.user.orgId),
            eq(projects.isActive, true),
          )}${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, authz.allowedSubsidiaryIds)}`).orderBy(projects.name),
        db.select({ id: parties.id, name: parties.displayName }).from(parties)
          .innerJoin(employeeRoles, and(
            eq(employeeRoles.orgId, parties.orgId),
            eq(employeeRoles.partyId, parties.id),
            eq(employeeRoles.isActive, true),
          ))
          .where(sql`${and(
            eq(parties.orgId, authz.user.orgId),
            eq(parties.isActive, true),
          )}${subsidiaryVisibleFilter(sql`parties.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}`).orderBy(parties.displayName),
        db.select({ id: items.id, name: items.name }).from(items)
          .where(and(
            eq(items.orgId, authz.user.orgId),
            eq(items.isActive, true),
            eq(items.kind, "service"),
          )).orderBy(items.name),
      ])
    : [[], [], []];
  const headerDefs = requested ? await loadFieldDefs("res_requests", "resourcing_request") : [];
  const resolved = requested
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: "resourcing_request",
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs,
        lineDefs: [],
        explicitLayoutId: pickString(sp.form),
      })
    : null;

  let weeks: RequestWeekPreview[] = [];
  if (request) {
    const range = weeksBetween(String(request.firstWeek).slice(0, 10), String(request.lastWeek).slice(0, 10));
    if (request.employeePartyId) {
      const availability = await readAvailability(
        authz.user.orgId,
        [request.employeePartyId],
        range[0]!,
        range.at(-1)!,
        authz.allowedSubsidiaryIds,
      );
      const assignmentRows = await db.select({ assignment: resAssignments }).from(resAssignments)
        .innerJoin(projects, and(
          eq(projects.orgId, resAssignments.orgId),
          eq(projects.id, resAssignments.projectId),
        ))
        .where(sql`${and(
          eq(resAssignments.orgId, authz.user.orgId),
          eq(resAssignments.employeePartyId, request.employeePartyId),
          eq(resAssignments.state, "active"),
          gte(resAssignments.weekStart, range[0]!),
          lte(resAssignments.weekStart, range.at(-1)!),
        )}${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, authz.allowedSubsidiaryIds)}`);
      const window: ForecastWindow = {
        firstWeek: range[0]!,
        lastWeek: range.at(-1)!,
        asOf: await businessToday(authz.user.orgId),
        rolloffWeeks: 0,
      };
      const forecast = buildResourcingForecast(
        assignmentRows.map(({ assignment }) => assignment),
        availability,
        window,
      );
      weeks = range.map((weekStart) => {
        const fact = forecast.personWeeks.find((entry) => entry.weekStart === weekStart);
        const hardHours = fact
          ? add(fact.hardBillableHours, fact.hardNonBillableHours)
          : "0.0000";
        return {
          weekStart,
          requestedHours: request.hoursPerWeek,
          hardHours,
          netCapacity: fact?.netCapacity ?? null,
          overallocated: fact?.netCapacity == null
            ? null
            : cmp(add(hardHours, request.hoursPerWeek), fact.netCapacity) > 0,
        };
      });
    } else {
      weeks = range.map((weekStart) => ({
        weekStart,
        requestedHours: request.hoursPerWeek,
        hardHours: null,
        netCapacity: null,
        overallocated: null,
      }));
    }
  }

  const drawer: RequestDrawerData | null = requested
    ? {
        remountKey: request?.id ?? "new-resource-request",
        request: request ? {
          id: request.id,
          projectId: request.projectId,
          employeePartyId: request.employeePartyId,
          jobTitle: request.jobTitle,
          firstWeek: String(request.firstWeek).slice(0, 10),
          lastWeek: String(request.lastWeek).slice(0, 10),
          hoursPerWeek: request.hoursPerWeek,
          isBillable: request.isBillable,
          billItemId: request.billItemId,
          reason: request.reason,
          status: request.status,
          decisionComment: request.decisionComment,
          custom: request.custom,
        } : null,
        projectName: loaded?.projectName ?? null,
        employeeName: loaded?.employeeName ?? null,
        billItemName: loaded?.billItemName ?? null,
        projects: projectsResult,
        employees: employeeRows,
        billItems: itemsResult,
        headerDefs: headerDefs as unknown as CustomFieldDefClient[],
        canManage,
        createMode,
        closeHref: mergeHref("/resourcing/requests", sp, { request: undefined, form: undefined }),
        layout: resolved!.layout,
        weeks,
      }
    : null;

  return {
    title: t("title"),
    description: t("description"),
    newRequestLabel: t("newRequest"),
    currentParams: sp,
    canManage,
    drawer,
  };
}

const f = ref<ResourceRequestsData>();

export function resourceRequestsSpec(data: ResourceRequestsData): PageSpec {
  const newRequest = {
    widget: "link-button",
    props: { href: "/resourcing/requests?request=new", label: data.newRequestLabel },
  };
  return page({
    route: '/resourcing/requests',
    layout: "list",
    header: [pageHeader({ title: f("title"), description: f("description"), actions: [widget(newRequest.widget, newRequest.props, f("canManage"))] })],
    body: [widgetBlock("entity-list-view", {
      recordType: "resourcing_request",
      sp: data.currentParams,
      drawer: data.drawer ? { widget: "resourcing-request-drawer", props: { drawer: data.drawer } } : null,
      emptyAction: data.canManage ? newRequest : null,
    })],
  });
}
