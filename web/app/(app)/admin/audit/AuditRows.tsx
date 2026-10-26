"use client";

import { PagedTable } from "../../../../components/paged-table";
import { auditActionLabel } from "../../../../lib/audit-action-label";
import { useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Badge } from "@openbooks/ui";
import { ChevronRight } from "lucide-react";
import { formatCivilDate } from "../../../../lib/format";

export type AuditListRow = {
  id: string;
  rowId: string;
  at: string;
  actorName: string | null;
  action: string;
  recordType: string;
  /** The record's display label (number, code, name or date), when its family has one. */
  recordLabel: { label: string | null; on: string | null } | null;
  summaryKind: "snapshot" | "metadata" | "fields";
  changeCount: number;
};

const ACTION_VARIANT: Record<
  string,
  "success" | "secondary" | "warning" | "destructive" | "outline"
> = {
  insert: "success",
  update: "secondary",
  delete: "destructive",
  post: "success",
  void: "warning",
  approve: "success",
  reject: "destructive",
};

const ACRONYMS = new Set(["api", "fx", "gl", "id", "url"]);

const humanize = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(" ")
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");

/** A record's display label with the date that identifies it, in the viewer's notation. */
export function auditRecordText(label: AuditListRow["recordLabel"], locale: string): string | null {
  if (!label) return null;
  const parts = [label.label, label.on ? formatCivilDate(label.on, locale) : null].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function AuditRows({ rows }: { rows: AuditListRow[]; selectedId?: string }) {
  const t = useTranslations("admin.audit");
  const format = useFormatter();
  const locale = useLocale();
  const searchParams = useSearchParams();
  const actionLabel = (action: string) => auditActionLabel(t as never, action, humanize);
  const when = (row: AuditListRow) =>
    format.dateTime(new Date(row.at), {
      dateStyle: "medium",
      timeStyle: "short",
    });

  function openEvent(id: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("event", id);
    window.history.pushState(null, "", `/admin/audit?${next.toString()}`);
  }

  return (
    <PagedTable
      source="admin_audit"
      rows={rows}
      rowKey={(row) => row.id}
      empty=""
      rowClassName={() =>
        "group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
      }
      onRowClick={(row) => openEvent(row.id)}
      rowRole="link"
      rowSelected={(row) => searchParams.get("event") === row.id}
      rowLabel={(row) =>
        t("openEventAria", {
          action: actionLabel(row.action),
          recordType: humanize(row.recordType),
          when: when(row),
        })
      }
      columns={[
        {
          key: "at",
          header: t("table.when"),
          className: "whitespace-nowrap",
          cell: when,
        },
        {
          key: "actor",
          header: t("table.actor"),
          cell: (row) =>
            row.actorName ?? <span className="text-slate-400">{t("systemActor")}</span>,
        },
        {
          key: "action",
          header: t("table.action"),
          cell: (row) => (
            <Badge variant={ACTION_VARIANT[row.action] ?? "secondary"}>
              {actionLabel(row.action)}
            </Badge>
          ),
        },
        {
          key: "recordType",
          header: t("table.tableName"),
          className: "font-medium text-slate-800 dark:text-slate-200",
          cell: (row) => humanize(row.recordType),
        },
        {
          key: "rowId",
          header: t("table.row"),
          className: "max-w-64",
          cell: (row) => {
            const shown = auditRecordText(row.recordLabel, locale);
            return shown ? (
              <span
                className="block truncate text-sm text-slate-700 dark:text-slate-200"
                title={shown}
              >
                {shown}
              </span>
            ) : (
              <span
                className="font-mono text-xs text-slate-500 dark:text-slate-400"
                title={row.rowId}
              >{`${row.rowId.slice(0, 8)}…`}</span>
            );
          },
        },
        {
          key: "details",
          header: t("table.changes"),
          cell: (row) => {
            const summary =
              row.summaryKind === "snapshot"
                ? t("summaries.snapshot")
                : row.summaryKind === "metadata"
                  ? t("summaries.metadata")
                  : t("summaries.changeCount", { count: row.changeCount });
            return (
              <span className="flex items-center justify-between gap-3 text-sm text-slate-500 dark:text-slate-400">
                <span>{summary}</span>
                <ChevronRight
                  size={16}
                  aria-hidden
                  className="shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-teal-600 dark:text-slate-600 dark:group-hover:text-teal-400"
                />
              </span>
            );
          },
        },
      ]}
    />
  );
}
