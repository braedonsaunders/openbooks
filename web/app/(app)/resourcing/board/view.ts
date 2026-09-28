import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { grid, page, pageHeader, ref, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { projects } from "@openbooks/schema";
import { addCalendarDays, businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { weekStartOf, weeksBetween } from "@openbooks/engine/src/resourcing/weeks.ts";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid, pickString } from "../../../../lib/list-params";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { subsidiaryVisibleFilter } from "../../../../lib/subsidiaries";
import { loadDemandWeeks, type DemandWeek } from "../../../../lib/resourcing/demand";
import { loadResourcingBoard, type ResourcingBoard } from "../../../../lib/resourcing/queries";
import { loadAssignmentDrawerData, type AssignmentDrawerData } from "../../../../lib/resourcing/assignment-drawer";

type DepartmentOption = { id: string; name: string };
type JobTitleOption = { job_title: string };
type QualificationOption = { id: string; name: string };

export type ResourcingBoardPageData = {
  title: string;
  description: string;
  labels: Record<string, string>;
  currentParams: Record<string, string | string[] | undefined>;
  board: ResourcingBoard;
  demand: DemandWeek[];
  weeks: string[];
  view: "person" | "project";
  canManage: boolean;
  filterOptions: {
    departments: { value: string; label: string }[];
    jobTitles: { value: string; label: string }[];
    skills: { value: string; label: string }[];
    projects: { value: string; label: string }[];
  };
  drawer: (AssignmentDrawerData & { remountKey: string; closeHref: string }) | {
    notFound: true;
    remountKey: string;
    closeHref: string;
  } | null;
};

function queryDate(value: string | undefined, fallback: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  try {
    return weekStartOf(value) === value ? value : fallback;
  } catch {
    return fallback;
  }
}

function queryWeeks(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 4 && parsed <= 26 ? parsed : 12;
}

function closePath(path: string, params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "assignment" || key === "person" || key === "week" || key === "prefillProject" || key === "prefillHours") continue;
    if (typeof value === "string") search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export async function loadResourcingBoardPage(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<ResourcingBoardPageData> {
  const authz = await requirePermission("resourcing.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "resourcing");
  const [today, certificatesOn] = await Promise.all([
    businessToday(orgId),
    isFeatureEnabled(orgId, "hrmCertifications"),
  ]);
  const fallbackSunday = weekStartOf(today);
  const firstSunday = queryDate(pickString(searchParams.from), fallbackSunday);
  const weekCount = queryWeeks(pickString(searchParams.weeks));
  const weeks = weeksBetween(firstSunday, addCalendarDays(firstSunday, (weekCount - 1) * 7));
  const lastSunday = weeks.at(-1)!;
  const departmentId = isUuid(pickString(searchParams.department)) ? pickString(searchParams.department) : undefined;
  const projectId = isUuid(pickString(searchParams.project)) ? pickString(searchParams.project) : undefined;
  const qualificationTypeId = certificatesOn && isUuid(pickString(searchParams.skill))
    ? pickString(searchParams.skill)
    : undefined;
  const jobTitle = pickString(searchParams.jobTitle)?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(pickString(searchParams.page) ?? "1", 10) || 1);
  const view = pickString(searchParams.view) === "project" ? "project" : "person";
  const onDate = today;

  const [t, departments, jobTitles, skills, projectOptions] = await Promise.all([
    import("next-intl/server").then(({ getTranslations }) => getTranslations("resourcing")),
    db.execute<DepartmentOption>(sql`
      select id, name from departments where org_id = ${orgId} and is_active
        ${subsidiaryVisibleFilter(sql`departments.subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by name, id
    `),
    db.execute<JobTitleOption>(sql`
      select distinct er.job_title from employee_roles er
      join parties p on p.org_id = er.org_id and p.id = er.party_id
       where er.org_id = ${orgId} and er.is_active and er.job_title is not null
         and p.is_active
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by er.job_title
    `),
    certificatesOn
      ? db.execute<QualificationOption>(sql`
          select id, name from hrm_qualification_types
           where org_id = ${orgId} and is_active order by name, id
        `)
      : Promise.resolve({ rows: [] as QualificationOption[] }),
    db.select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(
        eq(projects.orgId, orgId),
        eq(projects.isActive, true),
        subsidiaryVisibleFilter(sql`projects.subsidiary_id`, authz.allowedSubsidiaryIds),
      ))
      .orderBy(projects.name, projects.id),
  ]);
  const board = await loadResourcingBoard(orgId, authz.allowedSubsidiaryIds, {
    firstSunday,
    lastSunday,
    projectId,
    departmentId,
    jobTitle,
    qualificationTypeId,
    onDate,
    page,
  });
  const demand = await loadDemandWeeks(orgId, authz.allowedSubsidiaryIds, {
    firstSunday,
    lastSunday,
    departmentId,
    jobTitle,
  });
  const currentParams = {
    ...searchParams,
    from: firstSunday,
    weeks: String(weekCount),
    view,
    page: String(board.page),
  };

  const assignmentParam = pickString(searchParams.assignment);
  let drawer: ResourcingBoardPageData["drawer"] = null;
  if (assignmentParam && (isUuid(assignmentParam) || assignmentParam === "new")) {
    const createMode = assignmentParam === "new" && can(authz, "resourcing.manage");
    const prefill = createMode ? {
      projectId: isUuid(pickString(searchParams.prefillProject)) ? pickString(searchParams.prefillProject)! : "",
      employeePartyId: isUuid(pickString(searchParams.person)) ? pickString(searchParams.person)! : "",
      jobTitle: "",
      weekStart: queryDate(pickString(searchParams.week), firstSunday),
      plannedHours: pickString(searchParams.prefillHours) ?? "8.0000",
    } : undefined;
    const resolved = assignmentParam === "new" && !createMode
      ? null
      : await loadAssignmentDrawerData({
          orgId,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          assignmentId: createMode ? null : assignmentParam,
          createMode,
          prefill,
        });
    if (resolved) {
      drawer = {
        ...resolved,
        remountKey: `${assignmentParam}:${prefill?.employeePartyId ?? ""}:${prefill?.weekStart ?? ""}`,
        closeHref: closePath("/resourcing/board", currentParams),
      };
    } else if (!createMode) {
      drawer = {
        notFound: true,
        remountKey: assignmentParam,
        closeHref: closePath("/resourcing/board", currentParams),
      };
    }
  }

  return {
    title: t("board.title"),
    description: t("board.description"),
    labels: {
      noPeople: t("board.noPeople"),
      noCapacity: t("board.noCapacity"),
      capacityRemedy: t("board.capacityRemedy"),
      hard: t("board.hard"),
      soft: t("board.soft"),
      available: t("board.available"),
      week: t("board.week"),
      person: t("board.person"),
      project: t("board.project"),
      departments: t("board.departments"),
      jobTitles: t("board.jobTitles"),
      skills: t("board.skills"),
      projects: t("board.projects"),
      all: t("board.all"),
      demandTitle: t("board.demandTitle"),
      generic: t("board.generic"),
      excluded: t("board.excluded"),
      manual: t("board.manual"),
      pipeline: t("board.pipeline"),
      release: t("board.release"),
      addAssignment: t("board.addAssignment"),
      page: t("board.page", { page: board.page, total: board.total }),
      backToPeople: t("board.backToPeople"),
      noAssignments: t("board.noAssignments"),
      dragToAssign: t("board.dragToAssign"),
      weeks: t("board.weeks"),
      startDate: t("board.startDate"),
      view: t("board.view"),
      excludedReasons: t("board.excludedReasons"),
    },
    currentParams,
    board,
    demand,
    weeks,
    view,
    canManage: can(authz, "resourcing.manage"),
    filterOptions: {
      departments: departments.rows.map((row) => ({ value: row.id, label: row.name })),
      jobTitles: jobTitles.rows.map((row) => ({ value: row.job_title, label: row.job_title })),
      skills: skills.rows.map((row) => ({ value: row.id, label: row.name })),
      projects: projectOptions.map((row) => ({ value: row.id, label: row.name })),
    },
    drawer,
  };
}

const f = ref<ResourcingBoardPageData>();

export function resourcingBoardSpec(data: ResourcingBoardPageData): PageSpec {
  return page({
    route: '/resourcing/board',
    layout: "list",
    header: [pageHeader({ title: f("title"), description: f("description") })],
    body: [grid("grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]", [
      widgetBlock("resourcing-board", {
        board: data.board,
        weeks: data.weeks,
        view: data.view,
        canManage: data.canManage,
        currentParams: data.currentParams,
        filterOptions: data.filterOptions,
        labels: data.labels,
      }),
      widgetBlock("resourcing-demand-rail", {
        genericDemand: data.board.forecast.genericDemand,
        assignments: data.board.rows,
        demand: data.demand,
        projectNames: Object.fromEntries(data.filterOptions.projects.map((project) => [project.value, project.label])),
        canManage: data.canManage,
        labels: data.labels,
      }),
    ]), widgetBlock("resourcing-assignment-drawer", {
      drawer: data.drawer,
      canManage: data.canManage,
    })],
  });
}
