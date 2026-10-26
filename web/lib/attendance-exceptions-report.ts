import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { civilDateParams } from "./format";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";
import { SCHEDULE_BOARD_TYPES } from "@openbooks/engine/schedule-boards/board-types";
import {
  attendanceExceptions,
  type AttendanceExceptionKind,
  type AttendanceExceptionRow,
} from "@openbooks/engine/schedule-boards/attendance";
import type { Authz } from "./authz";
import type { ExportData } from "./report-pdf";
import { pgTextArrayLiteral } from "./pg-array";
import { isUuid } from "./list-params";

/**
 * The Attendance exceptions report: ended shifts on roster boards whose
 * current device attendance needs attention — absences, late arrivals,
 * early leaves, breaks over plan and grace, and shifts still waiting for a
 * device to synchronize. The observations are the attendance engine's; this
 * module selects the boards the reader may see and lays the rows out for
 * screen and export.
 */

export const ATTENDANCE_EXCEPTION_KINDS: readonly AttendanceExceptionKind[] = [
  "absent",
  "late",
  "left_early",
  "over_break",
  "waiting_for_sync",
];

export const ATTENDANCE_REPORT_PARAMS = { board: "board", kind: "kind" } as const;

const ATTENDANCE_TYPES = SCHEDULE_BOARD_TYPES.filter((type) =>
  type.capabilities.includes("attendance"),
).map((type) => type.key);

/** Active boards whose type observes attendance, within the reader's legal entities. */
export async function attendanceBoardOptions(
  authz: Authz,
): Promise<{ id: string; label: string }[]> {
  const rows = await db.execute<{ id: string; code: string; name: string }>(
    sql`
    select id, code, name from schedule_boards
     where org_id = ${authz.user.orgId} and is_active and board_type = any(${pgTextArrayLiteral(ATTENDANCE_TYPES)}::text[])
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
     order by name, code, id limit 500`,
    "objects",
  );
  return rows.map((row) => ({ id: row.id, label: `${row.code} · ${row.name}` }));
}

export interface AttendanceExceptionReportRow {
  readonly key: string;
  readonly date: string;
  readonly person: string;
  readonly board: string;
  readonly scheduled: string;
  readonly firstIn: string;
  readonly lastOut: string;
  readonly exceptions: string;
  readonly closed: string;
}

function kindsOf(row: AttendanceExceptionRow): AttendanceExceptionKind[] {
  if (row.status !== "present") return [row.status];
  return [
    ...(row.late ? ["late" as const] : []),
    ...(row.leftEarly ? ["left_early" as const] : []),
    ...(row.overBreak ? ["over_break" as const] : []),
  ];
}

export async function attendanceExceptionReport(
  authz: Authz,
  input: {
    from: string;
    through: string;
    boardId?: string;
    kind?: AttendanceExceptionKind;
    search?: string;
  },
): Promise<AttendanceExceptionReportRow[]> {
  const t = await getTranslations("reports.attendanceExceptions");
  const rows = await attendanceExceptions({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    from: input.from,
    through: input.through,
    boardId: input.boardId ?? null,
    kinds: input.kind ? [input.kind] : undefined,
    search: input.search ?? null,
  });
  // Clock times read in the booking's own time zone, as the board shows them.
  const clock = (value: string | null, zone: string) =>
    value
      ? new Intl.DateTimeFormat("en-CA", {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: zone,
        }).format(new Date(value))
      : "—";
  return rows.map((row) => ({
    key: row.observationId,
    date: row.onDate,
    person: row.workerName,
    board: row.boardName,
    scheduled: `${clock(row.startsAt, row.timeZone)}–${clock(row.endsAt, row.timeZone)}`,
    firstIn: clock(row.firstIn, row.timeZone),
    lastOut: clock(row.lastOut, row.timeZone),
    exceptions: kindsOf(row)
      .map((kind) => t(`kinds.${kind}`))
      .join(", "),
    closed: row.closed ? t("closed") : "",
  }));
}

/** The board and exception filters a request names, kept only when they are real options. */
export function attendanceReportFilters(
  read: (key: string) => string | null | undefined,
  boards: readonly { id: string }[],
): { boardId?: string; kind?: AttendanceExceptionKind } {
  const board = read(ATTENDANCE_REPORT_PARAMS.board);
  const kind = read(ATTENDANCE_REPORT_PARAMS.kind);
  return {
    boardId:
      board && isUuid(board) && boards.some((option) => option.id === board) ? board : undefined,
    kind:
      kind && (ATTENDANCE_EXCEPTION_KINDS as readonly string[]).includes(kind)
        ? (kind as AttendanceExceptionKind)
        : undefined,
  };
}

/** The report as the shared paper/PDF/XLSX/CSV shape. */
export async function attendanceExceptionsExportData(
  authz: Authz,
  p: URLSearchParams,
  period: { from: string; to: string },
): Promise<ExportData> {
  const t = await getTranslations("reports.attendanceExceptions");
  const locale = await getLocale();
  const boards = await attendanceBoardOptions(authz);
  const filters = attendanceReportFilters((key) => p.get(key), boards);
  const rows = await attendanceExceptionReport(authz, {
    from: period.from,
    through: period.to,
    ...filters,
    search: p.get("q") ?? undefined,
  });
  return {
    title: t("title"),
    dateRangeLabel: t("range", civilDateParams({ from: period.from, to: period.to }, locale)),
    summary: [],
    groups: [
      {
        kind: "results",
        title: t("title"),
        columns: [
          t("columns.date"),
          t("columns.person"),
          t("columns.board"),
          t("columns.scheduled"),
          t("columns.firstIn"),
          t("columns.lastOut"),
          t("columns.exceptions"),
          t("columns.closed"),
        ],
        align: ["left", "left", "left", "left", "left", "left", "left", "left"],
        money: [false, false, false, false, false, false, false, false],
        rows: rows.map((row) => [
          row.date,
          row.person,
          row.board,
          row.scheduled,
          row.firstIn,
          row.lastOut,
          row.exceptions,
          row.closed,
        ]),
      },
    ],
  };
}
