"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Plug,
  RefreshCw,
  Play,
  FlaskConical,
  Trash2,
  Plus,
  Pencil,
  Copy,
  ExternalLink,
  Download,
  BookOpen,
  Paperclip,
  Calculator,
} from "lucide-react";
import Link from "next/link";
import { PagedTable, type PagedColumn } from "../../../components/paged-table";
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  PageHeader,
  Select,
  Textarea,
} from "@openbooks/ui";

// --- shapes (mirror the API responses) ---------------------------------------

interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  help?: string;
  kind?: "text" | "select" | "textarea";
  options?: { value: string; label: string }[];
  optionsSource?: "currencies";
}
interface Currency {
  code: string;
  name: string;
}
interface SourceTypeDef {
  source: string;
  displayName: string;
  authKind: "token" | "oauth2";
  blurb: string;
  configFields: FieldSpec[];
  secretFields: FieldSpec[];
  oauthSetup?: {
    portalUrl: string;
    portalLabel: string;
    steps: string[];
  } | null;
}
interface Connection {
  id: string;
  source: string;
  displayName: string;
  authKind: string;
  status: "active" | "paused" | "error" | "unconfigured";
  config: Record<string, unknown>;
  mirrorEnabled: boolean;
  mirrorSchedule: string;
  cursor: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  hasSecrets: boolean;
  runHealth?: {
    mirror?: {
      status?: string;
      finishedAt?: string | null;
      errorMessage?: string | null;
    };
    attachments?: {
      status?: string;
      finishedAt?: string | null;
      errorMessage?: string | null;
    };
  };
  unresolvedSourceDeletions?: string[];
  qbdStatus?: {
    heartbeat: string | null;
    captureStatus: string | null;
    captureProgress: { completed?: number; total?: number } | null;
  } | null;
}
interface Run {
  id: string;
  connectionId: string | null;
  source: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  stats?: {
    docsNew?: number;
    docsAmended?: number;
    docsUnchanged?: number;
    ordersNew?: number;
    docsFailed?: number;
    applications?: { inserted?: number } | null;
    tb?: { matches?: number; accounts?: number; mismatches?: unknown[] };
    openItems?: {
      checked?: number;
      matches?: number;
      mismatches?: unknown[];
    } | null;
    periods?: { checked?: number; matches?: number } | null;
    projectPeriods?: { checked?: number; matches?: number } | null;
    sourceDocuments?: number;
    targetDocuments?: number;
    newDocuments?: number;
    amendedDocuments?: number;
    unchangedDocuments?: number;
    sourceUnbuildable?: number;
    actionableSourceDeletions?: unknown[];
    ledgerContext?: { bookRef?: string; bookKind?: string } | null;
    financialVerification?: {
      tb?: { matches?: number; accounts?: number; mismatches?: unknown[] };
      openItems?: { checked?: number; matches?: number } | null;
      periods?: { checked?: number; matches?: number };
      projectPeriods?: { checked?: number; matches?: number } | null;
    };
    sourceFiles?: number;
    sourceLinks?: number;
    createdFiles?: number;
    createdLinks?: number;
    failures?: number;
    sourceTimeEntries?: number;
    targetTimeEntries?: number;
    exactTimeEntries?: number;
    changedTimeEntries?: number;
    missingTargetTimeEntries?: number;
    targetOnlyTimeEntries?: number;
    sourceProjects?: number;
    targetProjects?: number;
    exactProjects?: number;
    changedProjects?: number;
    missingTargetProjects?: number;
    targetOnlyProjects?: number;
  };
  progress?: {
    phase?: string;
    message?: string;
    current?: number;
    total?: number;
    docsNew?: number;
    docsAmended?: number;
    docsUnchanged?: number;
    docsFailed?: number;
    ordersNew?: number;
  };
  errorMessage: string | null;
  triggeredBy: string | null;
}
interface Payload {
  connections: Connection[];
  runs: Run[];
  sourceTypes: SourceTypeDef[];
  currencies: Currency[];
}

const STATUS_VARIANT: Record<string, "success" | "secondary" | "destructive"> =
  {
    active: "success",
    paused: "secondary",
    error: "destructive",
    unconfigured: "secondary",
  };

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function PlatformClient() {
  const t = useTranslations("sync");
  const tHub = useTranslations("admin.hub");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // `${id}:${action}`
  const [drawer, setDrawer] = useState<{ editing: Connection | null } | null>(
    null,
  );

  const load = useCallback(async () => {
    const res = await fetch("/api/platform/connections");
    if (!res.ok) {
      toast.error(t("toast.loadFailed", { status: res.status }));
      setLoading(false);
      return;
    }
    setData(await res.json());
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-poll while any run is in flight so the progress bar advances.
  const anyRunning = (data?.runs ?? []).some((r) => r.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => {
      void load();
    }, 2500);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  // Surface an OAuth callback result (e.g. QuickBooks), then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("oauth");
    if (!status) return;
    if (status === "connected") toast.success(t("toast.authorized"));
    else if (status === "denied") toast.error(t("toast.authDenied"));
    else toast.error(t("toast.authFailed", { status }));
    window.history.replaceState({}, "", window.location.pathname);
  }, [t]);

  // Enum-ish values from the API render through messages when a label exists,
  // otherwise fall back to the raw value (e.g. a kind added server-side first).
  const statusLabel = (s: string) =>
    t.has(`connections.status.${s}`) ? t(`connections.status.${s}`) : s;
  const kindLabel = (k: string) =>
    t.has(`runs.kind.${k}`) ? t(`runs.kind.${k}`) : k;
  const sourceLabel = (s: string) =>
    data?.sourceTypes.find((st) => st.source === s)?.displayName ?? s;
  const runStatusLabel = (s: string) =>
    t.has(`runs.status.${s}`) ? t(`runs.status.${s}`) : s;

  function runResult(r: Run): string {
    if (r.status !== "ok" || !r.stats) return r.errorMessage ?? "";
    const s = r.stats;
    if (r.kind === "attachments") {
      return t("runs.stats.attachments", {
        files: s.sourceFiles ?? 0,
        links: s.sourceLinks ?? 0,
        created: s.createdFiles ?? 0,
      });
    }
    if (r.kind === "project_financials") {
      return t("runs.stats.projectFinancials", {
        source: s.sourceTimeEntries ?? 0,
        exact: s.exactTimeEntries ?? 0,
        changed: s.changedTimeEntries ?? 0,
        projects: s.sourceProjects ?? 0,
        projectChanges: s.changedProjects ?? 0,
      });
    }
    if (r.kind === "full_preflight") {
      const financial = s.financialVerification;
      const parts = [
        t("runs.stats.preflightDocs", {
          source: s.sourceDocuments ?? 0,
          new: s.newDocuments ?? 0,
          amended: s.amendedDocuments ?? 0,
          unchanged: s.unchangedDocuments ?? 0,
        }),
      ];
      if (s.ledgerContext?.bookRef) {
        parts.push(
          t("runs.stats.sourceBook", {
            kind: s.ledgerContext.bookKind ?? "ledger",
            ref: s.ledgerContext.bookRef,
          }),
        );
      }
      if (financial?.tb) {
        parts.push(
          t("runs.stats.tb", {
            matches: financial.tb.matches ?? 0,
            accounts: financial.tb.accounts ?? 0,
          }),
        );
      }
      if (financial?.projectPeriods) {
        parts.push(
          t("runs.stats.projectPeriods", {
            matches: financial.projectPeriods.matches ?? 0,
            checked: financial.projectPeriods.checked ?? 0,
          }),
        );
      }
      const blockers =
        (s.sourceUnbuildable ?? 0) +
        (s.actionableSourceDeletions?.length ?? 0);
      if (blockers > 0) {
        parts.push(t("runs.stats.preflightBlockers", { count: blockers }));
      }
      return parts.join(" · ");
    }
    const parts = [
      t("runs.stats.docs", {
        new: s.docsNew ?? 0,
        amended: s.docsAmended ?? 0,
        unchanged: s.docsUnchanged ?? 0,
      }),
    ];
    if ((s.applications?.inserted ?? 0) > 0)
      parts.push(
        t("runs.stats.applied", { count: s.applications?.inserted ?? 0 }),
      );
    let tb = t("runs.stats.tb", {
      matches: s.tb?.matches ?? 0,
      accounts: s.tb?.accounts ?? 0,
    });
    if ((s.tb?.mismatches?.length ?? 0) > 0)
      tb += ` ${t("runs.stats.tbOff", { count: s.tb?.mismatches?.length ?? 0 })}`;
    parts.push(tb);
    if (s.openItems)
      parts.push(
        t("runs.stats.openItems", {
          matches: s.openItems.matches ?? 0,
          checked: s.openItems.checked ?? 0,
        }),
      );
    if (s.periods)
      parts.push(
        t("runs.stats.periods", {
          matches: s.periods.matches ?? 0,
          checked: s.periods.checked ?? 0,
        }),
      );
    if (s.projectPeriods)
      parts.push(
        t("runs.stats.projectPeriods", {
          matches: s.projectPeriods.matches ?? 0,
          checked: s.projectPeriods.checked ?? 0,
        }),
      );
    return parts.join(" · ");
  }

  /** Live progress bar for an in-flight run, else the final result summary. */
  function runResultNode(r: Run) {
    if (r.status === "running" && r.progress?.phase) {
      const p = r.progress;
      return (
        <div className="min-w-[240px] space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-300">
              {p.message ??
                (t.has(`runs.progress.${p.phase}`)
                  ? t(`runs.progress.${p.phase}`)
                  : runStatusLabel("running"))}
            </span>
            {p.total ? (
              <span className="tabular-nums text-slate-500">
                {(p.current ?? 0).toLocaleString()}/{p.total.toLocaleString()}
              </span>
            ) : null}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className={`h-full rounded-full bg-blue-500 transition-all duration-500 ${p.total ? "" : "animate-pulse"}`}
              style={{
                width: p.total
                  ? `${Math.min(100, Math.round((100 * (p.current ?? 0)) / p.total))}%`
                  : "45%",
              }}
            />
          </div>
          {typeof p.docsNew === "number" ? (
            <div className="text-xs text-slate-400">
              {t("runs.stats.docs", {
                new: p.docsNew ?? 0,
                amended: p.docsAmended ?? 0,
                unchanged: p.docsUnchanged ?? 0,
              })}
              {(p.docsFailed ?? 0) > 0 ? ` · ${p.docsFailed} failed` : ""}
            </div>
          ) : null}
        </div>
      );
    }
    return <span className="text-slate-500">{runResult(r)}</span>;
  }

  const colHeader = (key: string, fallback: string) =>
    t.has(`runs.columns.${key}`) ? t(`runs.columns.${key}`) : fallback;
  const runColumns: PagedColumn<Run>[] = [
    {
      key: "started",
      header: colHeader("started", "Started"),
      cell: (r) => fmt(r.startedAt),
      search: (r) => fmt(r.startedAt),
    },
    {
      key: "kind",
      header: colHeader("kind", "Kind"),
      cell: (r) => kindLabel(r.kind),
      search: (r) => kindLabel(r.kind),
    },
    {
      key: "source",
      header: colHeader("source", "Source"),
      cell: (r) => sourceLabel(r.source),
      search: (r) => sourceLabel(r.source),
    },
    {
      key: "status",
      header: colHeader("status", "Status"),
      cell: (r) => (
        <Badge
          variant={
            r.status === "ok"
              ? "success"
              : r.status === "failed"
                ? "destructive"
                : "secondary"
          }
        >
          {runStatusLabel(r.status)}
        </Badge>
      ),
      search: (r) => runStatusLabel(r.status),
    },
    {
      key: "trigger",
      header: colHeader("trigger", "Trigger"),
      cell: (r) => r.triggeredBy ?? "—",
      search: (r) => r.triggeredBy ?? "",
    },
    {
      key: "result",
      header: colHeader("result", "Result"),
      cell: (r) => runResultNode(r),
      search: (r) => runResult(r),
    },
  ];

  async function run(
    conn: Connection,
    mode:
      | "full_migration"
      | "preflight"
      | "mirror"
      | "project_financials"
      | "attachments",
  ) {
    const key = `${conn.id}:${mode}`;
    setBusy(key);
    const tid = toast.loading(
      mode === "full_migration"
        ? t("toast.queuingMigration")
        : mode === "preflight"
          ? t("toast.queuingPreflight")
        : mode === "project_financials"
          ? t("toast.queuingProjectFinancials")
        : mode === "attachments"
          ? t("toast.queuingAttachments")
          : t("toast.queuingMirror"),
    );
    try {
      const res = await fetch(`/api/platform/connections/${conn.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = await res.json();
      if (!res.ok) {
        const key =
          typeof body.errorCode === "string"
            ? `toast.runErrors.${body.errorCode}`
            : "";
        throw new Error(
          key && t.has(key)
            ? t(key)
            : t("toast.runFailed", { status: res.status }),
        );
      }
      toast.success(
        mode === "full_migration"
          ? t("toast.migrationQueued")
          : mode === "preflight"
            ? t("toast.preflightQueued")
          : mode === "project_financials"
            ? t("toast.projectFinancialsQueued")
          : mode === "attachments"
            ? t("toast.attachmentsQueued")
            : t("toast.mirrorQueued"),
        { id: tid },
      );
      setTimeout(() => void load(), 800);
    } catch (e) {
      toast.error((e as Error).message, { id: tid });
    } finally {
      setBusy(null);
    }
  }

  async function test(conn: Connection) {
    const key = `${conn.id}:test`;
    setBusy(key);
    const tid = toast.loading(t("toast.testing"));
    try {
      const res = await fetch(`/api/platform/connections/${conn.id}/test`, {
        method: "POST",
      });
      const body = await res.json();
      if (body.ok)
        toast.success(
          body.detail
            ? t("toast.connectedDetail", { detail: body.detail })
            : t("toast.connected"),
          { id: tid },
        );
      else
        toast.error(
          t("toast.testFailed", {
            error: body.error ?? t("toast.unknownError"),
          }),
          { id: tid, duration: 8000 },
        );
    } catch (e) {
      toast.error((e as Error).message, { id: tid });
    } finally {
      setBusy(null);
    }
  }

  async function toggleMirror(conn: Connection) {
    setBusy(`${conn.id}:mirror`);
    try {
      await fetch(`/api/platform/connections/${conn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mirrorEnabled: !conn.mirrorEnabled }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function setMirrorSchedule(conn: Connection, mirrorSchedule: string) {
    setBusy(`${conn.id}:schedule`);
    try {
      const res = await fetch(`/api/platform/connections/${conn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mirrorSchedule }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function resolveDeletion(
    conn: Connection,
    sourceRef: string,
    action: "retain" | "void",
  ) {
    const prompt =
      action === "void"
        ? t("confirmVoidSourceDeletion", { ref: sourceRef })
        : t("confirmRetainSourceDeletion", { ref: sourceRef });
    if (!confirm(prompt)) return;
    setBusy(`${conn.id}:deletion:${sourceRef}`);
    try {
      const res = await fetch(
        `/api/platform/connections/${conn.id}/source-deletions/${encodeURIComponent(sourceRef)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.success(
        t(
          action === "void" ? "toast.deletionVoided" : "toast.deletionRetained",
        ),
      );
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(conn: Connection) {
    if (!confirm(t("confirmDelete", { name: conn.displayName }))) return;
    setBusy(`${conn.id}:del`);
    try {
      await fetch(`/api/platform/connections/${conn.id}`, { method: "DELETE" });
      await load();
      toast.success(t("toast.removed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        back={{ href: "/admin", label: tHub("title") }}
        title={t("title")}
        description={t("description")}
      />

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {t("connections.heading")}
        </h2>
        <Button onClick={() => setDrawer({ editing: null })}>
          <Plus size={15} /> {t("connections.add")}
        </Button>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">
          {t("connections.loading")}
        </p>
      ) : !data || data.connections.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <Plug className="mx-auto mb-2 text-slate-400" size={22} />
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t("connections.empty.title")}
          </p>
          <p className="text-xs text-slate-500">
            {t("connections.empty.hint")}
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {data.connections.map((c) => (
            <div
              key={c.id}
              className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {c.displayName}
                  </span>
                  <Badge variant="secondary">{sourceLabel(c.source)}</Badge>
                  <Badge variant={STATUS_VARIANT[c.status] ?? "secondary"}>
                    {statusLabel(c.status)}
                  </Badge>
                  {c.mirrorEnabled ? (
                    <Badge variant="success">
                      {t("connections.mirrorBadge", {
                        schedule: c.mirrorSchedule,
                      })}
                    </Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {c.authKind === "oauth2" && c.status !== "active" ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        window.open(
                          `/api/platform/connections/oauth/${c.source}/start?connectionId=${c.id}`,
                          "_blank",
                        )
                      }
                    >
                      <Plug size={14} /> {t("actions.connect")}
                    </Button>
                  ) : null}
                  {c.authKind === "oauth2" && c.status === "active" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        window.open(
                          `/api/platform/connections/oauth/${c.source}/start?connectionId=${c.id}`,
                          "_blank",
                        )
                      }
                    >
                      {t("actions.reconnect")}
                    </Button>
                  ) : null}
                  {c.source === "qbd" ? (
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={`/api/platform/connections/${c.id}/qwc`}
                        download
                      >
                        <Download size={14} /> {t("actions.downloadQwc")}
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === `${c.id}:test`}
                    onClick={() => test(c)}
                  >
                    <FlaskConical size={14} /> {t("actions.test")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === `${c.id}:mirror`}
                    onClick={() => run(c, "mirror")}
                  >
                    <RefreshCw size={14} /> {t("actions.mirrorNow")}
                  </Button>
                  {c.source === "netsuite" ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === `${c.id}:project_financials`}
                        onClick={() => run(c, "project_financials")}
                      >
                        <Calculator size={14} />{" "}
                        {t("actions.syncProjectFinancials")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === `${c.id}:attachments`}
                        onClick={() => run(c, "attachments")}
                      >
                        <Paperclip size={14} /> {t("actions.syncAttachments")}
                      </Button>
                    </>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === `${c.id}:preflight`}
                    onClick={() => run(c, "preflight")}
                  >
                    <BookOpen size={14} /> {t("actions.preflight")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy === `${c.id}:full_migration`}
                    onClick={() => run(c, "full_migration")}
                  >
                    <Play size={14} /> {t("actions.runMigration")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggleMirror(c)}
                  >
                    {c.mirrorEnabled
                      ? t("actions.pauseMirror")
                      : t("actions.enableMirror")}
                  </Button>
                  <Select
                    aria-label={t("connections.schedule")}
                    className="h-8 w-auto text-xs"
                    value={c.mirrorSchedule}
                    disabled={busy === `${c.id}:schedule`}
                    onChange={(event) =>
                      void setMirrorSchedule(c, event.target.value)
                    }
                  >
                    {!["hourly", "every_6_hours", "daily", "weekly"].includes(
                      c.mirrorSchedule,
                    ) ? (
                      <option value={c.mirrorSchedule}>
                        {c.mirrorSchedule}
                      </option>
                    ) : null}
                    <option value="hourly">
                      {t("connections.schedules.hourly")}
                    </option>
                    <option value="every_6_hours">
                      {t("connections.schedules.every_6_hours")}
                    </option>
                    <option value="daily">
                      {t("connections.schedules.daily")}
                    </option>
                    <option value="weekly">
                      {t("connections.schedules.weekly")}
                    </option>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDrawer({ editing: c })}
                  >
                    <Pencil size={14} /> {t("actions.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === `${c.id}:del`}
                    onClick={() => remove(c)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                {t("connections.lastRun", {
                  lastRun: fmt(c.lastRunAt),
                  cursor: fmt(c.cursor),
                })}
                {c.lastError ? (
                  <span className="text-red-500"> · {c.lastError}</span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>
                  {t("connections.mirrorHealth")}:{" "}
                  {c.runHealth?.mirror?.status
                    ? runStatusLabel(c.runHealth.mirror.status)
                    : "—"}
                  {c.runHealth?.mirror?.finishedAt
                    ? ` · ${fmt(c.runHealth.mirror.finishedAt)}`
                    : ""}
                </span>
                {c.source === "netsuite" ? (
                  <span>
                    {t("connections.attachmentHealth")}:{" "}
                    {c.runHealth?.attachments?.status
                      ? runStatusLabel(c.runHealth.attachments.status)
                      : "—"}
                    {c.runHealth?.attachments?.finishedAt
                      ? ` · ${fmt(c.runHealth.attachments.finishedAt)}`
                      : ""}
                  </span>
                ) : null}
              </div>
              {(c.unresolvedSourceDeletions?.length ?? 0) > 0 ? (
                <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/20">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    {t("connections.sourceDeletions")}
                  </p>
                  <p className="mt-1 text-amber-800 dark:text-amber-300">
                    {t("connections.sourceDeletionHint")}
                  </p>
                  <div className="mt-2 space-y-2">
                    {c.unresolvedSourceDeletions?.map((sourceRef) => (
                      <div
                        key={sourceRef}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <code>{sourceRef}</code>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy === `${c.id}:deletion:${sourceRef}`}
                            onClick={() =>
                              void resolveDeletion(c, sourceRef, "retain")
                            }
                          >
                            {t("actions.retainDeletion")}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy === `${c.id}:deletion:${sourceRef}`}
                            onClick={() =>
                              void resolveDeletion(c, sourceRef, "void")
                            }
                          >
                            {t("actions.voidDeletion")}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {c.source === "qbd" ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>
                    {c.qbdStatus?.heartbeat
                      ? t("qbd.lastContact", {
                          time: fmt(c.qbdStatus.heartbeat),
                        })
                      : t("qbd.notConnected")}
                  </span>
                  {c.qbdStatus?.captureStatus ? (
                    <span>
                      {t("qbd.capture", {
                        status: t.has(
                          `qbd.captureStatus.${c.qbdStatus.captureStatus}`,
                        )
                          ? t(`qbd.captureStatus.${c.qbdStatus.captureStatus}`)
                          : c.qbdStatus.captureStatus,
                        completed: c.qbdStatus.captureProgress?.completed ?? 0,
                        total: c.qbdStatus.captureProgress?.total ?? 0,
                      })}
                    </span>
                  ) : null}
                  <Link
                    href="/docs/quickbooks-desktop-connector"
                    className="inline-flex items-center gap-1 text-sky-700 hover:underline dark:text-sky-300"
                  >
                    <BookOpen size={12} /> {t("qbd.documentation")}
                  </Link>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Recent runs — paginated + searchable */}
      {data && data.runs.length > 0 ? (
        <div className="mt-8 space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            {t("runs.heading")}
          </h2>
          <PagedTable
            rows={data.runs}
            columns={runColumns}
            pageSize={15}
            searchable
            rowKey={(r) => r.id}
            empty={
              <p className="text-sm text-slate-500">{t("runs.heading")}</p>
            }
          />
        </div>
      ) : null}

      {data ? (
        <ConnectionDrawer
          open={drawer !== null}
          onClose={() => setDrawer(null)}
          sourceTypes={data.sourceTypes}
          currencies={data.currencies}
          editing={drawer?.editing}
          onSaved={() => {
            setDrawer(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

// --- Add-connection wizard (drawer) ------------------------------------------

/**
 * App-registration guidance for OAuth sources: where to create the app, the
 * steps, and the EXACT redirect URI for this deployment (composed from the
 * browser origin, with one-click copy) — so a tenant never has to guess what
 * to paste into the developer portal.
 *
 * Steps are looked up by manifest source key (`sync.sources.<source>.steps`);
 * the manifest's English text is the fallback for sources without messages.
 */
function OauthSetupBox({
  source,
  setup,
}: {
  source: string;
  setup: NonNullable<SourceTypeDef["oauthSetup"]>;
}) {
  const t = useTranslations("sync");
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const redirectUri = `${origin}/api/platform/connections/oauth/${source}/callback`;

  // Object.values, not a plain cast: the English-fallback deep merge turns
  // message arrays into `{0: …, 1: …}` objects for non-default locales.
  const stepsKey = `sources.${source}.steps`;
  const steps = t.has(stepsKey)
    ? Object.values(t.raw(stepsKey) as Record<string, string>)
    : setup.steps;

  async function copy() {
    try {
      await navigator.clipboard.writeText(redirectUri);
      toast.success(t("toast.copied"));
    } catch {
      toast.error(t("toast.copyFailed"));
    }
  }

  return (
    <div className="rounded-md border border-sky-200 bg-sky-50/50 p-3 text-xs dark:border-sky-900/40 dark:bg-sky-900/10">
      <p className="mb-2 font-medium text-sky-800 dark:text-sky-300">
        {t.rich("oauth.title", {
          portal: setup.portalLabel,
          link: (chunks) => (
            <a
              href={setup.portalUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-sky-600"
            >
              {chunks}
              <ExternalLink size={11} />
            </a>
          ),
        })}
      </p>
      <ol className="mb-3 list-decimal space-y-1 pl-4 text-slate-600 dark:text-slate-300">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <p className="mb-1 font-medium text-slate-600 dark:text-slate-300">
        {t("oauth.redirectLabel")}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[11px] text-slate-800 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700">
          {redirectUri}
        </code>
        <Button variant="outline" size="sm" onClick={copy}>
          <Copy size={13} /> {t("oauth.copy")}
        </Button>
      </div>
    </div>
  );
}

function configOptions(
  f: FieldSpec,
  currencies: Currency[],
): { value: string; label: string }[] {
  if (f.optionsSource === "currencies")
    return currencies.map((c) => ({
      value: c.code,
      label: `${c.code} — ${c.name}`,
    }));
  return f.options ?? [];
}

function ConnectionDrawer({
  open,
  onClose,
  sourceTypes,
  currencies,
  editing,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  sourceTypes: SourceTypeDef[];
  currencies: Currency[];
  /** When set, the drawer edits this connection instead of creating one. */
  editing?: Connection | null;
  onSaved: () => void;
}) {
  const t = useTranslations("sync");
  const [source, setSource] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Prefill from the edited connection (or clear for a fresh add) on open.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setSource(editing.source);
      setDisplayName(editing.displayName);
      setConfig(
        Object.fromEntries(
          Object.entries(editing.config ?? {}).map(([k, v]) => [
            k,
            String(v ?? ""),
          ]),
        ),
      );
      setSecrets({});
    } else {
      setSource("");
      setDisplayName("");
      setConfig({});
      setSecrets({});
    }
  }, [open, editing]);

  const def = sourceTypes.find((s) => s.source === source);
  // Blurbs are keyed by manifest source; the manifest's English text is the
  // fallback for a source that has no message entry yet.
  const blurbKey = def ? `sources.${def.source}.blurb` : "";
  const blurb = def ? (t.has(blurbKey) ? t(blurbKey) : def.blurb) : "";
  const fieldLabel = (f: FieldSpec) =>
    def && t.has(`sources.${def.source}.fields.${f.key}.label`)
      ? t(`sources.${def.source}.fields.${f.key}.label`)
      : f.label;
  const fieldHelp = (f: FieldSpec) =>
    def && t.has(`sources.${def.source}.fields.${f.key}.help`)
      ? t(`sources.${def.source}.fields.${f.key}.help`)
      : f.help;

  async function save() {
    if (!def) return;
    setSaving(true);
    try {
      const provided = Object.fromEntries(
        Object.entries(secrets).filter(([, v]) => v !== ""),
      );
      const res = editing
        ? await fetch(`/api/platform/connections/${editing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName, config, secrets: provided }),
          })
        : await fetch("/api/platform/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source,
              displayName,
              config,
              secrets: provided,
            }),
          });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.success(editing ? t("toast.updated") : t("toast.created"));
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? t("drawer.editTitle") : t("drawer.addTitle")}
      description={t("drawer.description")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("drawer.cancel")}
          </Button>
          {def ? (
            <Button disabled={saving} onClick={save}>
              {saving
                ? t("drawer.saving")
                : editing
                  ? t("drawer.saveChanges")
                  : t("drawer.create")}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>{t("drawer.system")}</Label>
          {editing ? (
            <Input value={def?.displayName ?? editing.source} disabled />
          ) : (
            <Select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setConfig({});
                setSecrets({});
              }}
            >
              <option value="">{t("drawer.selectSystem")}</option>
              {sourceTypes.map((s) => (
                <option key={s.source} value={s.source}>
                  {s.displayName}
                </option>
              ))}
            </Select>
          )}
        </div>

        {def ? (
          <>
            {!editing ? (
              <p className="text-xs text-slate-500">{blurb}</p>
            ) : null}
            {def.authKind === "oauth2" && def.oauthSetup ? (
              <OauthSetupBox source={def.source} setup={def.oauthSetup} />
            ) : null}
            {def.source === "qbd" ? (
              <div className="rounded-md border border-sky-200 bg-sky-50/50 p-3 text-xs text-slate-600 dark:border-sky-900/40 dark:bg-sky-900/10 dark:text-slate-300">
                <p className="font-medium text-sky-800 dark:text-sky-300">
                  {t("qbd.setupTitle")}
                </p>
                <p className="mt-1">{t("qbd.setupHint")}</p>
              </div>
            ) : null}
            {def.source === "netsuite" ? (
              <div className="rounded-md border border-sky-200 bg-sky-50/50 p-3 text-xs text-slate-600 dark:border-sky-900/40 dark:bg-sky-900/10 dark:text-slate-300">
                <p className="font-medium text-sky-800 dark:text-sky-300">
                  {t("netsuite.setupTitle")}
                </p>
                <p className="mt-1">{t("netsuite.setupHint")}</p>
                <Link
                  href="/docs/netsuite-extraction-bridge"
                  className="mt-2 inline-flex items-center gap-1 font-medium text-sky-700 hover:underline dark:text-sky-300"
                >
                  <BookOpen size={13} /> {t("netsuite.documentation")}
                </Link>
              </div>
            ) : null}
            <div>
              <Label>{t("drawer.name")}</Label>
              <Input
                value={displayName}
                placeholder={def.displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>

            {def.configFields.map((f) => (
              <div key={f.key}>
                <Label>
                  {fieldLabel(f)}
                  {f.required ? " *" : ""}
                </Label>
                {f.kind === "select" ? (
                  <Select
                    value={config[f.key] ?? ""}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, [f.key]: e.target.value }))
                    }
                  >
                    <option value="">{t("drawer.select")}</option>
                    {configOptions(f, currencies).map((o) => (
                      <option key={o.value} value={o.value}>
                        {def &&
                        t.has(`sources.${def.source}.options.${o.value}`)
                          ? t(`sources.${def.source}.options.${o.value}`)
                          : o.label}
                      </option>
                    ))}
                  </Select>
                ) : f.kind === "textarea" ? (
                  <Textarea
                    value={config[f.key] ?? ""}
                    placeholder={f.placeholder}
                    rows={10}
                    className="font-mono text-xs"
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, [f.key]: e.target.value }))
                    }
                  />
                ) : (
                  <Input
                    value={config[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, [f.key]: e.target.value }))
                    }
                  />
                )}
                {fieldHelp(f) ? (
                  <p className="mt-1 text-xs text-slate-400">{fieldHelp(f)}</p>
                ) : null}
              </div>
            ))}

            {def.secretFields.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900/40 dark:bg-amber-900/10">
                <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                  {t("drawer.credentials")}
                </p>
                <div className="space-y-3">
                  {def.secretFields.map((f) => (
                    <div key={f.key}>
                      <Label>
                        {fieldLabel(f)}
                        {f.required && !editing ? " *" : ""}
                      </Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        placeholder={
                          editing ? t("drawer.keepCurrent") : undefined
                        }
                        value={secrets[f.key] ?? ""}
                        onChange={(e) =>
                          setSecrets((s) => ({ ...s, [f.key]: e.target.value }))
                        }
                      />
                      {fieldHelp(f) ? (
                        <p className="mt-1 text-xs text-slate-400">
                          {fieldHelp(f)}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
