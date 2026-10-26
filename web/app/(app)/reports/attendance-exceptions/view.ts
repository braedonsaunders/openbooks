import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { civilDateParams } from "../../../../lib/format";
import {
  column,
  field,
  ref,
  rootRef,
  table,
  text,
  textBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { ScheduleError } from "@openbooks/engine/schedule-boards/errors";
import { statementReportSpec } from "@/lib/reports/statement-report-spec";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { orgInfo } from "../../../../lib/data";
import { resolvePeriod } from "../../../../lib/periods";
import { parseReportQuery } from "../../../../lib/report-filters";
import {
  ATTENDANCE_EXCEPTION_KINDS,
  ATTENDANCE_REPORT_PARAMS,
  attendanceBoardOptions,
  attendanceExceptionReport,
  attendanceReportFilters,
  type AttendanceExceptionReportRow,
} from "../../../../lib/attendance-exceptions-report";

/**
 * Attendance exceptions, split into a loader and a spec like the other
 * statement reports: the observations are the attendance engine's, so the
 * loader calls it and the page only lays out one row per shift.
 */

type Filter = {
  paramKey: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
};

export interface AttendanceExceptionsData {
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
  company: string;
  rangePhrase: string;
  note: string;
  searchPlaceholder: string;
  filters: Filter[];
  exportParams: Record<string, string | undefined>;
  columns: Record<
    "date" | "person" | "board" | "scheduled" | "firstIn" | "lastOut" | "exceptions" | "closed",
    string
  >;
  rows: AttendanceExceptionReportRow[];
  empty: string;
  refusal: string | null;
}

export async function loadAttendanceExceptionsReport(
  sp: Record<string, string | undefined>,
): Promise<AttendanceExceptionsData> {
  await requirePermission("reports.read");
  const authz = await requirePermission("hrm.attendance.read");
  const orgId = authz.user.orgId;
  for (const feature of ["hrm", "hrmShiftPlanning", "hrmAttendance"])
    await requireFeatureEnabled(orgId, feature);
  const t = await getTranslations("reports.attendanceExceptions");
  const locale = await getLocale();
  const tr = await getTranslations("reports");
  const q = parseReportQuery(sp);
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId });
  const boards = await attendanceBoardOptions(authz);
  const filters = attendanceReportFilters((key) => sp[key], boards);
  let rows: AttendanceExceptionReportRow[] = [];
  let refusal: string | null = null;
  try {
    rows = await attendanceExceptionReport(authz, {
      from: period.from,
      through: period.to,
      ...filters,
      search: sp.q,
    });
  } catch (error) {
    if (!(error instanceof ScheduleError)) throw error;
    refusal = error.remedy ? `${error.message} ${error.remedy}` : error.message;
  }
  const org = await orgInfo(orgId);
  return {
    title: t("title"),
    description: t("description"),
    backHref: "/reports",
    backLabel: tr("hub.title"),
    company: org?.name ?? "",
    rangePhrase: t("range", civilDateParams({ from: period.from, to: period.to }, locale)),
    note: t("note"),
    searchPlaceholder: t("search"),
    filters: [
      {
        paramKey: ATTENDANCE_REPORT_PARAMS.board,
        label: t("columns.board"),
        value: filters.boardId ?? "",
        options: [
          { value: "", label: t("allBoards") },
          ...boards.map((board) => ({ value: board.id, label: board.label })),
        ],
      },
      {
        paramKey: ATTENDANCE_REPORT_PARAMS.kind,
        label: t("columns.exceptions"),
        value: filters.kind ?? "",
        options: [
          { value: "", label: t("allKinds") },
          ...ATTENDANCE_EXCEPTION_KINDS.map((kind) => ({ value: kind, label: t(`kinds.${kind}`) })),
        ],
      },
    ],
    exportParams: sp,
    columns: {
      date: t("columns.date"),
      person: t("columns.person"),
      board: t("columns.board"),
      scheduled: t("columns.scheduled"),
      firstIn: t("columns.firstIn"),
      lastOut: t("columns.lastOut"),
      exceptions: t("columns.exceptions"),
      closed: t("columns.closed"),
    },
    rows,
    empty: refusal ?? t("empty"),
    refusal,
  };
}

const f = ref<AttendanceExceptionsData>();
const rootF = rootRef<AttendanceExceptionsData>();
const item = field;

export function attendanceExceptionsSpec(data: AttendanceExceptionsData): PageSpec {
  return statementReportSpec({
    route: "/reports/attendance-exceptions",
    header: {
      title: f("title"),
      description: f("description"),
      back: { href: f("backHref"), label: f("backLabel") },
    },
    filters: [
      {
        controls: { search: true, period: true },
        options: {
          searchPlaceholder: f("searchPlaceholder"),
          primaryFilter: f("filters"),
        },
      },
    ],
    exportMenu: { kind: "attendance-exceptions", params: data.exportParams },
    paper: {
      company: f("company"),
      title: f("title"),
      periodPhrase: f("rangePhrase"),
      wide: true,
    },
    blocks: [
      table({
        variant: "report",
        rows: f("rows"),
        rowKey: item("key"),
        emptyRow: { text: f("empty"), colSpan: 8 },
        columns: [
          column(rootF("columns.date"), text(item("date")), { className: "tabular-nums" }),
          column(rootF("columns.person"), text(item("person")), { className: "font-medium" }),
          column(rootF("columns.board"), text(item("board"))),
          column(rootF("columns.scheduled"), text(item("scheduled")), {
            className: "tabular-nums",
          }),
          column(rootF("columns.firstIn"), text(item("firstIn")), { className: "tabular-nums" }),
          column(rootF("columns.lastOut"), text(item("lastOut")), { className: "tabular-nums" }),
          column(rootF("columns.exceptions"), text(item("exceptions"))),
          column(rootF("columns.closed"), text(item("closed")), { className: "text-slate-500" }),
        ],
      }),
      textBlock(f("note"), { tone: "muted", className: "mt-3" }),
    ],
  });
}
