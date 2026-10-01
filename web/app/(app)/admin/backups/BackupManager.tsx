"use client";

import { PagedTable, type PagedColumn } from "../../../../components/paged-table";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";
import { confirmDialog } from "@/lib/confirm";

export interface BackupPolicyRow {
  enabled: boolean;
  frequency: "daily" | "weekly" | "monthly";
  hourUtc: number;
  dayOfWeek: number;
  dayOfMonth: number;
  maxKeep: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface BackupRunRow {
  id: string;
  kind: "manual" | "scheduled";
  status: "queued" | "running" | "completed" | "failed";
  fileName: string | null;
  byteSize: number | null;
  tableCount: number | null;
  rowCount: number | null;
  sha256: string | null;
  error: string | null;
  purgedAt: string | null;
  purgeReason: "rotated" | "deleted" | null;
  createdAt: string;
  completedAt: string | null;
}

const STATUS_VARIANT: Record<string, "default" | "warning" | "destructive" | "success" | "secondary"> = {
  queued: "warning",
  running: "warning",
  completed: "success",
  failed: "destructive",
};

function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export interface BackupManagerProps {
  policy: BackupPolicyRow | null;
  runs: BackupRunRow[];
  totalRuns: number;
  s3Enabled: boolean;
  workerOnline: boolean;
}

export function BackupManager({
  policy,
  runs,
  totalRuns,
  s3Enabled,
  workerOnline,
}: BackupManagerProps) {
  const locale = useLocale();
  const { dateTime, number } = useViewerFormat();
  const formatWhen = (iso: string | null) => iso ? dateTime(new Date(iso)) : "—";
  const router = useRouter();
  const t = useTranslations("admin.backupsManager");
  const formatUtcHour = (hour: number) => new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, hour)));
  const [pending, start] = useTransition();

  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [frequency, setFrequency] = useState(policy?.frequency ?? "daily");
  const [hourUtc, setHourUtc] = useState(policy?.hourUtc ?? 2);
  const [dayOfWeek, setDayOfWeek] = useState(policy?.dayOfWeek ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(policy?.dayOfMonth ?? 1);
  const [maxKeep, setMaxKeep] = useState(policy?.maxKeep ?? 7);

  const hasActiveRun = runs.some((r) => r.status === "queued" || r.status === "running");

  // Live progress: re-render from the server while a run is in flight.
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [hasActiveRun, router]);

  const savePolicy = () =>
    start(async () => {
      const res = await fetch("/api/admin/backups/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, frequency, hourUtc, dayOfWeek, dayOfMonth, maxKeep }),
      });
      if (!res.ok) {
        toast.error(t("errors.couldNotSave"));
        return;
      }
      toast.success(enabled ? t("toasts.scheduleSaved") : t("toasts.scheduleOff"));
      router.refresh();
    });

  const runNow = () =>
    start(async () => {
      const res = await fetch("/api/admin/backups/run", { method: "POST" });
      if (!res.ok) {
        toast.error(t("errors.couldNotStart"));
        return;
      }
      toast.success(t("toasts.started"));
      router.refresh();
    });

  const deleteRun = (run: BackupRunRow) => {
    start(async () => {
      if (!(await confirmDialog(t("deleteConfirm", { fileName: run.fileName ? ` “${run.fileName}”` : "" })))) {
        return;
      }
      const res = await fetch(`/api/admin/backups/${run.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(t("errors.couldNotDelete"));
        return;
      }
      toast.success(t("toasts.deleted"));
      router.refresh();
    });
  };

  // Stored runs as the shared collection table: search, paging and empty
  // states come from PagedTable over the registered admin_backups source.
  // The schedule editor above and the run-now/delete mutations stay as-is.
  const backupColumns: PagedColumn<BackupRunRow>[] = [
    {
      key: 'created',
      header: t("table.created"),
      cell: (run) => <span className="whitespace-nowrap">{formatWhen(run.createdAt)}</span>,
      search: (run) => `${run.fileName ?? ''} ${formatWhen(run.createdAt)}`,
    },
    {
      key: 'kind',
      header: t("table.kind"),
      cell: (run) => <Badge variant="outline">{t(`table.kinds.${run.kind}`)}</Badge>,
      search: (run) => run.kind,
    },
    {
      key: 'status',
      header: t("table.status"),
      cell: (run) => (
        <>
          <Badge variant={STATUS_VARIANT[run.status] ?? "secondary"}>{t(`table.statuses.${run.status}`)}</Badge>
          {run.error && (
            <div className="mt-1 max-w-64 text-xs break-words text-red-600 dark:text-red-400">
              {run.error}
            </div>
          )}
        </>
      ),
      search: (run) => `${run.status} ${run.error ?? ''}`,
    },
    {
      key: 'size',
      header: t("table.size"),
      cell: (run) => <span className="whitespace-nowrap">{formatBytes(run.byteSize)}</span>,
    },
    {
      key: 'contents',
      header: t("table.contents"),
      cell: (run) => (
        <span className="whitespace-nowrap">
          {run.rowCount !== null
            ? t("table.rowsTables", { rows: number(run.rowCount), tables: run.tableCount ?? 0 })
            : "—"}
        </span>
      ),
    },
    {
      key: 'sha256',
      header: t("table.sha256"),
      cell: (run) => (
        <span className="block max-w-72 font-mono text-xs break-all text-slate-500 dark:text-slate-400">
          {run.sha256 ?? "—"}
        </span>
      ),
      search: (run) => run.sha256 ?? '',
    },
    {
      key: 'retention',
      header: t("table.retention"),
      cell: (run) => (
        run.purgedAt ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {t("table.purged", { reason: run.purgeReason ? t(`table.reasons.${run.purgeReason}`) : "", when: formatWhen(run.purgedAt) })}
          </span>
        ) : (
          <span className="text-xs text-slate-500 dark:text-slate-400">{t("table.kept")}</span>
        )
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t("table.actionsSr")}</span>,
      className: 'text-right whitespace-nowrap',
      cell: (run) => {
        const active = run.status === "queued" || run.status === "running";
        const downloadable = run.status === "completed" && !run.purgedAt;
        return (
          <>
            {downloadable && (
              <>
                <a
                  href={`/api/admin/backups/${run.id}/download`}
                  className="mr-3 text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
                >
                  {t("table.archive")}
                </a>
                <a
                  href={`/api/admin/backups/${run.id}/manifest`}
                  className="mr-3 text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
                >
                  {t("table.manifest")}
                </a>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => deleteRun(run)}
                  className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                >
                  {t("table.delete")}
                </button>
              </>
            )}
            {active && <span className="text-xs text-slate-400">{t("table.inProgress")}</span>}
          </>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      {!s3Enabled && (
        <Alert variant="warning">
          <AlertTitle>{t("alerts.noObjectStorageTitle")}</AlertTitle>
          <AlertDescription>
            {t.rich("alerts.noObjectStorageBody", {
              cli: (chunks) => <code>{chunks}</code>,
            })}
          </AlertDescription>
        </Alert>
      )}
      {s3Enabled && !workerOnline && (
        <Alert variant="warning">
          <AlertTitle>{t("alerts.workerOfflineTitle")}</AlertTitle>
          <AlertDescription>
            {t("alerts.workerOfflineBody")}
          </AlertDescription>
        </Alert>
      )}

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("exportsCard.title")}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t.rich("exportsCard.body", {
            archive: (chunks) => <strong>{chunks}</strong>,
            manifest: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("autoCard.title")}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t.rich("autoCard.body", {
            keep: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2 pb-2">
            <input
              id="bk-enabled"
              type="checkbox"
              className="h-4 w-4 accent-teal-600"
              checked={enabled}
              disabled={!s3Enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <Label htmlFor="bk-enabled">{t("autoCard.enabled")}</Label>
          </div>
          <div>
            <Label htmlFor="bk-frequency">{t("autoCard.frequency")}</Label>
            <Select
              id="bk-frequency"
              value={frequency}
              disabled={!s3Enabled}
              onChange={(e) => setFrequency(e.target.value as BackupPolicyRow["frequency"])}
            >
              <option value="daily">{t("autoCard.daily")}</option>
              <option value="weekly">{t("autoCard.weekly")}</option>
              <option value="monthly">{t("autoCard.monthly")}</option>
            </Select>
          </div>
          {frequency === "weekly" && (
            <div>
              <Label htmlFor="bk-dow">{t("autoCard.dayOfWeek")}</Label>
              <Select
                id="bk-dow"
                value={String(dayOfWeek)}
                disabled={!s3Enabled}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
              >
                {Array.from({ length: 7 }, (_, i) => (
                  <option key={i} value={i}>
                    {t(`weekdays.${i}`)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {frequency === "monthly" && (
            <div>
              <Label htmlFor="bk-dom">{t("autoCard.dayOfMonth")}</Label>
              <Select
                id="bk-dom"
                value={String(dayOfMonth)}
                disabled={!s3Enabled}
                onChange={(e) => setDayOfMonth(Number(e.target.value))}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="bk-hour">{t("autoCard.timeUtc")}</Label>
            <Select
              id="bk-hour"
              value={String(hourUtc)}
              disabled={!s3Enabled}
              onChange={(e) => setHourUtc(Number(e.target.value))}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {formatUtcHour(h)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="bk-keep">{t("autoCard.keepNewest")}</Label>
            <Input
              id="bk-keep"
              type="number"
              min={1}
              max={100}
              className="w-24"
              value={maxKeep}
              disabled={!s3Enabled}
              onChange={(e) => setMaxKeep(Number(e.target.value))}
            />
          </div>
          <Button disabled={pending || !s3Enabled} onClick={savePolicy}>
            {t("autoCard.saveSchedule")}
          </Button>
        </div>
        {policy && (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            {policy.enabled && policy.nextRunAt
              ? t("autoCard.nextRun", { when: formatWhen(policy.nextRunAt) })
              : t("autoCard.off")}
            {policy.lastRunAt ? t("autoCard.lastSuccess", { when: formatWhen(policy.lastRunAt) }) : ""}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("storedCard.title")}</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {t("storedCard.body", { count: policy?.maxKeep ?? maxKeep })}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t("storedCard.runCount", { shown: runs.length, total: totalRuns })}
            </p>
          </div>
          <Button variant="default" disabled={pending || !s3Enabled || hasActiveRun} onClick={runNow}>
            {t("storedCard.backUpNow")}
          </Button>
        </div>

        <div className="mt-4">
          <PagedTable
            source="admin_backups"
            rows={runs}
            rowKey={(run) => run.id}
            searchable
            emptyAsRow
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t("storedCard.noneYet")}</p>}
            columns={backupColumns}
          />
        </div>
      </Card>
    </div>
  );
}
