"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
        toast.error(body.error ?? "could not save the backup policy");
        return;
      }
      toast.success(enabled ? "Backup schedule saved" : "Scheduled backups turned off");
      router.refresh();
    });

  const runNow = () =>
    start(async () => {
      const res = await fetch("/api/admin/backups/run", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? "could not start the backup");
        return;
      }
      toast.success("Backup started — it will appear below");
      router.refresh();
    });

  const deleteRun = (run: BackupRunRow) => {
    if (!window.confirm(`Delete the stored backup${run.fileName ? ` “${run.fileName}”` : ""}? This cannot be undone.`)) {
      return;
    }
    start(async () => {
      const res = await fetch(`/api/admin/backups/${run.id}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? "could not delete the backup");
        return;
      }
      toast.success("Backup deleted");
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      {!s3Enabled && (
        <Alert variant="warning">
          <AlertTitle>Object storage is not configured</AlertTitle>
          <AlertDescription>
            This deployment has no S3 object storage (S3_ENDPOINT / S3_BUCKET / credentials), so stored and
            scheduled backups are unavailable. <strong>Download now</strong> still works — it streams a fresh
            backup straight to your browser.
          </AlertDescription>
        </Alert>
      )}
      {s3Enabled && !workerOnline && (
        <Alert variant="warning">
          <AlertTitle>Background worker is offline</AlertTitle>
          <AlertDescription>
            Stored and scheduled backups run on the background worker, which has not reported in recently.
            New runs will stay queued until it starts.
          </AlertDescription>
        </Alert>
      )}

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Download now</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          A consistent point-in-time export of the entire organization — every table, including the audit
          history — as a gzip-compressed JSON Lines (.json.gz) archive. The download is recorded in the audit
          log.
        </p>
        <div className="mt-4">
          <Button onClick={() => window.location.assign("/api/admin/backups/download")}>
            Download backup (.json.gz)
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Automatic backups</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Back up to the deployment&apos;s S3 object storage on a schedule. Only the newest{" "}
          <strong>keep</strong> backups are retained — older ones are rotated out automatically after each
          successful run.
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
            <Label htmlFor="bk-enabled">Enabled</Label>
          </div>
          <div>
            <Label htmlFor="bk-frequency">Frequency</Label>
            <Select
              id="bk-frequency"
              value={frequency}
              disabled={!s3Enabled}
              onChange={(e) => setFrequency(e.target.value as BackupPolicyRow["frequency"])}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </div>
          {frequency === "weekly" && (
            <div>
              <Label htmlFor="bk-dow">Day of week</Label>
              <Select
                id="bk-dow"
                value={String(dayOfWeek)}
                disabled={!s3Enabled}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
              >
                {WEEKDAYS.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {frequency === "monthly" && (
            <div>
              <Label htmlFor="bk-dom">Day of month</Label>
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
            <Label htmlFor="bk-hour">Time (UTC)</Label>
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
            <Label htmlFor="bk-keep">Keep newest</Label>
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
            Save schedule
          </Button>
        </div>
        {policy && (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            {policy.enabled && policy.nextRunAt
              ? `Next scheduled run: ${formatWhen(policy.nextRunAt)} (UTC schedule)`
              : "Scheduled backups are off."}
            {policy.lastRunAt ? ` · Last successful backup: ${formatWhen(policy.lastRunAt)}` : ""}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Stored backups</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              The newest {policy?.maxKeep ?? maxKeep} completed backups are kept in object storage; the rest
              are rotated out. Deleting a backup removes it from storage immediately.
            </p>
          </div>
          <Button variant="default" disabled={pending || !s3Enabled || hasActiveRun} onClick={runNow}>
            Back up now
          </Button>
        </div>

        {runs.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">No stored backups yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs tracking-wider text-slate-400 uppercase dark:border-slate-800 dark:text-slate-500">
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 pr-4 font-medium">Kind</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Size</th>
                  <th className="py-2 pr-4 font-medium">Contents</th>
                  <th className="py-2 pr-4 font-medium">SHA-256</th>
                  <th className="py-2 pr-4 font-medium">Retention</th>
                  <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>
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
                          ? `${run.rowCount.toLocaleString()} rows · ${run.tableCount ?? 0} tables`
                          : "—"}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {run.sha256 ? `${run.sha256.slice(0, 12)}…` : "—"}
                      </td>
                      <td className="py-2.5 pr-4 whitespace-nowrap">
                        {run.purgedAt ? (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            purged ({run.purgeReason}) · {formatWhen(run.purgedAt)}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500 dark:text-slate-400">kept</span>
                        )}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        {downloadable && (
                          <>
                            <a
                              href={`/api/admin/backups/${run.id}/download`}
                              className="mr-3 text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
                            >
                              Download
                            </a>
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => deleteRun(run)}
                              className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                            >
                              Delete
                            </button>
                          </>
                        )}
                        {active && <span className="text-xs text-slate-400">in progress…</span>}
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
