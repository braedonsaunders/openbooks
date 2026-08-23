"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";

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

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function BackupManager({
  policy,
  runs,
  s3Enabled,
  workerOnline,
}: {
  policy: BackupPolicyRow | null;
  runs: BackupRunRow[];
  s3Enabled: boolean;
  workerOnline: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("admin.backupsManager");
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
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? t("errors.couldNotSave"));
        return;
      }
      toast.success(enabled ? t("toasts.scheduleSaved") : t("toasts.scheduleOff"));
      router.refresh();
    });

  const runNow = () =>
    start(async () => {
      const res = await fetch("/api/admin/backups/run", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? t("errors.couldNotStart"));
        return;
      }
      toast.success(t("toasts.started"));
      router.refresh();
    });

  const deleteRun = (run: BackupRunRow) => {
    if (!window.confirm(t("deleteConfirm", { fileName: run.fileName ? ` “${run.fileName}”` : "" }))) {
      return;
    }
    start(async () => {
      const res = await fetch(`/api/admin/backups/${run.id}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? t("errors.couldNotDelete"));
        return;
      }
      toast.success(t("toasts.deleted"));
      router.refresh();
    });
  };

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
                  {String(h).padStart(2, "0")}:00
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
          </div>
          <Button variant="default" disabled={pending || !s3Enabled || hasActiveRun} onClick={runNow}>
            {t("storedCard.backUpNow")}
          </Button>
        </div>

        {runs.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{t("storedCard.noneYet")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs tracking-wider text-slate-400 uppercase dark:border-slate-800 dark:text-slate-500">
                  <th className="py-2 pr-4 font-medium">{t("table.created")}</th>
                  <th className="py-2 pr-4 font-medium">{t("table.kind")}</th>
                  <th className="py-2 pr-4 font-medium">{t("table.status")}</th>
                  <th className="py-2 pr-4 font-medium">{t("table.size")}</th>
                  <th className="py-2 pr-4 font-medium">{t("table.contents")}</th>
                  <th className="py-2 pr-4 font-medium">{t("table.sha256")}</th>
                  <th className="py-2 pr-4 font-medium">{t("table.retention")}</th>
                  <th className="py-2 font-medium"><span className="sr-only">{t("table.actionsSr")}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {runs.map((run) => {
                  const active = run.status === "queued" || run.status === "running";
                  const downloadable = run.status === "completed" && !run.purgedAt;
                  return (
                    <tr key={run.id} className="align-top">
                      <td className="py-2.5 pr-4 whitespace-nowrap text-slate-700 dark:text-slate-300">
                        {formatWhen(run.createdAt)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge variant="outline">{run.kind}</Badge>
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={STATUS_VARIANT[run.status] ?? "secondary"}>{run.status}</Badge>
                        {run.error && (
                          <div className="mt-1 max-w-64 text-xs break-words text-red-600 dark:text-red-400">
                            {run.error}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 whitespace-nowrap text-slate-700 dark:text-slate-300">
                        {formatBytes(run.byteSize)}
                      </td>
                      <td className="py-2.5 pr-4 whitespace-nowrap text-slate-700 dark:text-slate-300">
                        {run.rowCount !== null
                          ? t("table.rowsTables", { rows: run.rowCount.toLocaleString(), tables: run.tableCount ?? 0 })
                          : "—"}
                      </td>
                      <td className="max-w-72 py-2.5 pr-4 font-mono text-xs break-all text-slate-500 dark:text-slate-400">
                        {run.sha256 ?? "—"}
                      </td>
                      <td className="py-2.5 pr-4 whitespace-nowrap">
                        {run.purgedAt ? (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {t("table.purged", { reason: run.purgeReason ?? "", when: formatWhen(run.purgedAt) })}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500 dark:text-slate-400">{t("table.kept")}</span>
                        )}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap">
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
