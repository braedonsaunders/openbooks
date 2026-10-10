"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
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
  MoreHorizontal,
  Sparkles,
} from "lucide-react";
import { MIGRATION_WORKSPACE_HREF } from "@/lib/migration/links";
import Link from "next/link";
import { ConnectionMappings, ConnectionSyncContent, type MappingDrafts } from "./ConnectionContent";
import { connectorSettings, resolveSyncSelection, validateConnectionMappings, type MappingGroup, type SyncCapabilities, type SyncContentKey } from "@openbooks/engine/src/sync/connection-settings.ts";
import { RecordTabs } from "@/components/module-home/record-tabs";
import { readApiErrorMessage } from "../../../lib/api-error";
import { confirmDialog } from "@/lib/confirm";
import { PagedTable, type PagedColumn } from "../../../components/paged-table";
import { ListPageLayout } from "../../../components/page-layout";
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuEntry,
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

/**
 * Config keys owned by the OAuth Connect callbacks (QBO realmId, Xero
 * tenantId, Dynamics companyId/companyName). Mirrors
 * CALLBACK_OWNED_CONFIG_KEYS in
 * web/app/api/platform/connections/_connector-guard.ts — the PATCH route
 * refuses these with 400 OAUTH_IDENTITY_REFUSED, so the edit drawer strips
 * them on prefill and on save instead of round-tripping them.
 */
const CALLBACK_OWNED_CONFIG_KEYS = new Set([
  "realmId",
  "tenantId",
  "companyId",
  "companyName",
]);

interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  help?: string;
  kind?: "text" | "select" | "textarea" | "mappings" | "sync-options";
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
  mappingGroups?: readonly MappingGroup[];
  syncCapabilities?: SyncCapabilities;
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
  postedChangePolicy: "review_required" | "append_only_automatic";
  postedChangeAuthorizedAt: string | null;
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
    partyMerges?: { absorbedRef?: string; survivorRef?: string }[];
    partyHolds?: string[];
    ledgerContext?: { bookRef?: string; bookKind?: string } | null;
    financialVerification?: {
      tb?: { matches?: number; accounts?: number; mismatches?: unknown[] };
      openItems?: { checked?: number; matches?: number } | null;
      periods?: { checked?: number; matches?: number };
      projectPeriods?: { checked?: number; matches?: number } | null;
    };
    excludedPopulations?: SyncContentKey[];
    attachments?: { sourceFiles: number; sourceLinks: number; createdFiles: number; newVersions: number; skippedUnchanged: number; failures: number };
    operationalRecords?: { disabledFeatures: string[]; crm?: { accounts: number; opportunities: number }; fixedAssets?: { target: { assets: number } } };
    projectFinancials?: { sourceProjects: number; changedProjects: number; sourceTimeEntries: number; exactTimeEntries: number; changedTimeEntries: number };
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
  /**
   * Whether the caller holds admin.setup.manage. Run-only callers (sync.run)
   * see the console and its run controls, but never the Add/Edit/Delete and
   * mirror-schedule controls — their edits would only fail at the API.
   */
  canManage?: boolean;
}

const STATUS_VARIANT: Record<string, "success" | "secondary" | "destructive"> =
  {
    active: "success",
    paused: "secondary",
    error: "destructive",
    unconfigured: "secondary",
  };

function subscribeSyncNavigation(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
function readSyncTab(): "connections" | "history" {
  return new URLSearchParams(window.location.search).get("tab") === "history" ? "history" : "connections";
}

export function PlatformClient() {
  const { dateTime, number } = useViewerFormat();
  const fmt = (ts: string | null) => ts ? dateTime(new Date(ts)) : "—";
  const t = useTranslations("sync");
  const tHub = useTranslations("admin.hub");
  const tCommon = useTranslations("common");
  const activeTab = useSyncExternalStore(subscribeSyncNavigation, readSyncTab, () => "connections" as const);
  const actionMenu = useContextMenu();
  const [actionConnection, setActionConnection] = useState<Connection | null>(null);
  function selectTab(tab: "connections" | "history") {
    actionMenu.close();
    const url = new URL(window.location.href);
    if (tab === "history") url.searchParams.set("tab", tab);
    else url.searchParams.delete("tab");
    window.history.pushState(window.history.state, "", url.pathname + url.search + url.hash);
    window.dispatchEvent(new window.PopStateEvent("popstate", { state: window.history.state }));
  }
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  // A refused or unreachable list load renders here, never as the empty
  // state: a 403 names its grant instead of reading "No connections yet",
  // and a transport failure offers a retry instead of spinning forever.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // `${id}:${action}`
  const [drawer, setDrawer] = useState<{ editing: Connection | null; presetSource?: string } | null>(
    null,
  );
  // The GET payload says whether the caller may reconfigure connections
  // (admin.setup.manage). A missing flag — a stale cached payload — reads
  // as manageable; the API still refuses run-only callers, so the worst
  // case is a failed edit, never a hidden control for a manager.
  const canManage = data?.canManage !== false;
  // `?connect=<source>` (the migration assistant's connect link) opens a new
  // connection for that source once the manifest has loaded. Read once at
  // mount; closing or saving the drawer consumes it.
  const [connectRequest, setConnectRequest] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("connect"));
  const openDrawer = drawer ?? (connectRequest && data && canManage ? { editing: null, presetSource: connectRequest } : null);
  const closeDrawer = () => {
    setDrawer(null);
    if (connectRequest) {
      setConnectRequest(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("connect");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  };

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const load = useCallback(() => {
    // load() sets no state synchronously — every update sits in a promise
    // continuation — so the mount effect below stays a pure fetch kickoff
    // (react-hooks/set-state-in-effect) and the 2.5s live poll refreshes
    // silently. Callers clear a shown error before re-arming (retryLoad) or
    // on success below, never here.
    return fetch("/api/platform/connections")
      .then(async (res) => {
        // The status is checked before the body is parsed: a 403 carries
        // the named grant ("missing permission: sync.run") and lands in
        // the error panel below, never in the empty state.
        if (!res.ok) {
          setLoadError(await readApiErrorMessage(res, t("toast.loadFailed", { status: res.status })));
          setLoading(false);
          return;
        }
        const payload = (await res.json()) as Payload;
        setData(payload);
        setLoadError(null);
        setLoading(false);
      })
      .catch(() => {
        // A transport failure rejects the fetch: without this catch the
        // loading state spins forever with nothing to retry.
        setLoadError(t("toast.loadFailed", { status: "network" }));
        setLoading(false);
      });
  }, [t]);

  function retryLoad() {
    setLoadError(null);
    setLoading(true);
    void load();
  }

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
    const url = new URL(window.location.href);
    url.searchParams.delete("oauth");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
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
      if (s.attachments) parts.push(t("runs.stats.incrementalAttachments", {
      created: s.attachments.createdFiles, changed: s.attachments.newVersions, skipped: s.attachments.skippedUnchanged,
    }));
    if (s.projectFinancials) parts.push(t("runs.stats.projectFinancials", {
      projects: s.projectFinancials.sourceProjects, projectChanges: s.projectFinancials.changedProjects,
      source: s.projectFinancials.sourceTimeEntries, exact: s.projectFinancials.exactTimeEntries,
      changed: s.projectFinancials.changedTimeEntries,
    }));
    if (s.operationalRecords?.crm) parts.push(t("runs.stats.crm", { accounts: s.operationalRecords.crm.accounts, opportunities: s.operationalRecords.crm.opportunities }));
    if (s.operationalRecords?.fixedAssets) parts.push(t("runs.stats.fixedAssets", { count: s.operationalRecords.fixedAssets.target.assets }));
    for (const feature of s.operationalRecords?.disabledFeatures ?? []) {
      parts.push(t("runs.stats.featureDisabled", { feature: t.has(`runs.features.${feature}`) ? t(`runs.features.${feature}`) : feature }));
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
    if ((s.partyMerges?.length ?? 0) > 0)
      parts.push(
        t("runs.stats.partyMerges", { count: s.partyMerges?.length ?? 0 }),
      );
    if ((s.partyHolds?.length ?? 0) > 0)
      parts.push(t("runs.stats.partyHolds", { count: s.partyHolds?.length ?? 0 }));
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
    if (s.attachments) parts.push(t("runs.stats.incrementalAttachments", {
      created: s.attachments.createdFiles, changed: s.attachments.newVersions, skipped: s.attachments.skippedUnchanged,
    }));
    if (s.projectFinancials) parts.push(t("runs.stats.projectFinancials", {
      projects: s.projectFinancials.sourceProjects, projectChanges: s.projectFinancials.changedProjects,
      source: s.projectFinancials.sourceTimeEntries, exact: s.projectFinancials.exactTimeEntries,
      changed: s.projectFinancials.changedTimeEntries,
    }));
    if (s.operationalRecords?.crm) parts.push(t("runs.stats.crm", { accounts: s.operationalRecords.crm.accounts, opportunities: s.operationalRecords.crm.opportunities }));
    if (s.operationalRecords?.fixedAssets) parts.push(t("runs.stats.fixedAssets", { count: s.operationalRecords.fixedAssets.target.assets }));
    for (const feature of s.operationalRecords?.disabledFeatures ?? []) parts.push(t("runs.stats.featureDisabled", { feature: t(`drawer.syncContent.labels.${feature}`) }));
    for (const key of s.excludedPopulations ?? []) parts.push(t("runs.stats.contentExcluded", { content: t(`drawer.syncContent.labels.${key}`) }));
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
                {number(p.current ?? 0)}/{number(p.total)}
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
      // The status is checked before the body is parsed: the error branch
      // parses best-effort (a non-JSON body keeps the generic failure), never
      // letting a SyntaxError from res.json() hide the failure.
      if (!res.ok) {
        const errorBody = (await res.json().catch(() => null)) as { errorCode?: unknown } | null;
        const key =
          typeof errorBody?.errorCode === "string"
            ? `toast.runErrors.${errorBody.errorCode}`
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
      // The status is checked before the body is parsed: a refusal (404/409/
      // 422) or a non-JSON error body (a 500 page, a gateway) must surface
      // the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("toast.testFailed", { error: t("toast.unknownError") })));
      const body = (await res.json().catch(() => null)) as {
        ok?: unknown;
        detail?: unknown;
        error?: unknown;
      } | null;
      if (body?.ok === true)
        toast.success(
          typeof body.detail === "string" && body.detail
            ? t("toast.connectedDetail", { detail: body.detail })
            : t("toast.connected"),
          { id: tid },
        );
      else
        toast.error(
          t("toast.testFailed", {
            error:
              typeof body?.error === "string" && body.error
                ? body.error
                : t("toast.unknownError"),
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
      const res = await fetch(`/api/platform/connections/${conn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mirrorEnabled: !conn.mirrorEnabled }),
      });
      // The status is checked before the body is parsed: a non-JSON error body
      // must surface the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
      await load();
    } catch (error) {
      toast.error((error as Error).message);
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
      // The status is checked before the body is parsed (see run above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(conn: Connection) {
    if (!(await confirmDialog(t("confirmDelete", { name: conn.displayName })))) return;
    setBusy(`${conn.id}:del`);
    try {
      const res = await fetch(`/api/platform/connections/${conn.id}`, {
        method: "DELETE",
      });
      // The status is checked before the body is parsed (see run above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, `HTTP ${res.status}`));
      await load();
      toast.success(t("toast.removed"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const connectionActions: ContextMenuEntry[] = actionConnection ? (() => {
    const c = data?.connections.find((connection) => connection.id === actionConnection.id);
    if (!c) return [];
    const blocked = busy !== null || (data?.runs ?? []).some((r) => r.connectionId === c.id && r.status === "running");
    const items: ContextMenuEntry[] = [
      { key: "test", label: t("actions.test"), icon: FlaskConical, disabled: busy !== null, onSelect: () => void test(c) },
      { key: "preflight", label: t("actions.preflight"), icon: BookOpen, disabled: blocked || c.status === "unconfigured", onSelect: () => void run(c, "preflight") },
      { key: "migration", label: t("actions.runMigration"), icon: Play, disabled: blocked || c.status === "unconfigured", onSelect: () => void run(c, "full_migration") },
    ];
    if (c.authKind === "oauth2") items.push({ key: "reconnect", label: t("actions.reconnect"), icon: Plug,
      onSelect: () => { window.open(`/api/platform/connections/oauth/${c.source}/start?connectionId=${c.id}`, "_blank"); } });
    if (c.source === "qbd") items.push({ key: "qwc", label: t("actions.downloadQwc"), icon: Download,
      onSelect: () => { window.location.assign(`/api/platform/connections/${c.id}/qwc`); } });
    if (canManage) items.push(
      { key: "management", separator: true },
      { key: "edit", label: t("actions.edit"), icon: Pencil, disabled: busy !== null, onSelect: () => setDrawer({ editing: c }) },
      { key: "remove", label: t("actions.remove", { name: c.displayName }), icon: Trash2, danger: true, disabled: blocked, onSelect: () => void remove(c) },
    );
    return items;
  })() : [];

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: "/admin", label: tHub("title") }}
          title={t("title")}
          description={t("description")}
          actions={canManage ? (
            <div className="flex items-center gap-2">
              <Button asChild variant="outline">
                <Link href={MIGRATION_WORKSPACE_HREF}>
                  <Sparkles size={15} /> {t("migrationAssistant.entry.sync")}
                </Link>
              </Button>
              <Button onClick={() => setDrawer({ editing: null })}>
                <Plus size={15} /> {t("connections.add")}
              </Button>
            </div>
          ) : undefined}
        />
      }
    >
      <RecordTabs label={t("title")} active={activeTab} onChange={selectTab}
        tabs={[{ key: "connections", label: t("connections.heading") }, { key: "history", label: t("runs.history") }]}>
      {loading ? (
        <p className="mt-4 text-sm text-slate-500">
          {t("connections.loading")}
        </p>
      ) : loadError ? (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <Plug className="mx-auto mb-2 text-slate-400" size={22} />
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {loadError}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={retryLoad}
          >
            {tCommon("actions.retry")}
          </Button>
        </div>
      ) : activeTab === "history" ? (
        <div className="mt-4"><PagedTable source="sync_runs" rows={data?.runs ?? []} columns={runColumns} pageSize={15} searchable
          rowKey={(r) => r.id} empty={<p className="text-sm text-slate-500">{t("runs.empty")}</p>} /></div>
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
                <div className="min-w-0 space-y-2">
                  <span className="block text-base font-semibold text-slate-800 dark:text-slate-100">
                    {c.displayName}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
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
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.authKind === "oauth2" && c.status !== "active" ? (
                    <Button size="sm" onClick={() => window.open(`/api/platform/connections/oauth/${c.source}/start?connectionId=${c.id}`, "_blank")}>
                      <Plug size={14} /> {t("actions.connect")}
                    </Button>
                  ) : (
                    <Button size="sm" disabled={busy !== null || data.runs.some((r) => r.connectionId === c.id && r.status === "running") || c.status === "unconfigured"}
                      onClick={() => void run(c, "mirror")}>
                      <RefreshCw size={14} /> {t("actions.syncNow")}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" aria-label={t("actions.more", { name: c.displayName })} aria-haspopup="menu"
                    aria-expanded={actionMenu.open && actionConnection?.id === c.id}
                    onClick={(event) => { setActionConnection(c); actionMenu.openBelow(event.currentTarget); }}>
                    <MoreHorizontal size={18} />
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
              {c.source === "netsuite" ? <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{t("connections.incrementalHint")}</p> : null}
              {canManage ? (
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <Label htmlFor={`schedule-${c.id}`} className="text-xs">{t("connections.schedule")}</Label>
                  <Select id={`schedule-${c.id}`} className="h-8 w-auto text-xs" value={c.mirrorSchedule}
                    disabled={busy !== null} onChange={(event) => void setMirrorSchedule(c, event.target.value)}>
                    {!["hourly", "every_6_hours", "daily", "weekly"].includes(c.mirrorSchedule) ? <option value={c.mirrorSchedule}>{c.mirrorSchedule}</option> : null}
                    {["hourly", "every_6_hours", "daily", "weekly"].map((schedule) => <option key={schedule} value={schedule}>{t(`connections.schedules.${schedule}`)}</option>)}
                  </Select>
                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void toggleMirror(c)}>
                    {c.mirrorEnabled ? t("actions.pauseMirror") : t("actions.enableMirror")}
                  </Button>
                </div>
              ) : null}
              {(c.unresolvedSourceDeletions?.length ?? 0) > 0 ? (
                <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/20">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    {t("connections.sourceDeletions")}
                  </p>
                  <p className="mt-1 text-amber-800 dark:text-amber-300">
                    {t("connections.sourceDeletionHint")}
                  </p>
                  <p className="mt-2 text-amber-800 dark:text-amber-300">
                    {t("connections.sourceDeletionCount", {
                      count: c.unresolvedSourceDeletions?.length ?? 0,
                    })}
                  </p>
                  <Button
                    className="mt-2"
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void run(c, "mirror")}
                  >
                    {t("actions.retryMirror")}
                  </Button>
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

      </RecordTabs>
      <ContextMenu open={actionMenu.open} position={actionMenu.position} onClose={actionMenu.close} items={connectionActions} />

      {data ? (
        <ConnectionDrawer
          open={openDrawer !== null}
          onClose={closeDrawer}
          sourceTypes={data.sourceTypes}
          currencies={data.currencies}
          editing={openDrawer?.editing}
          presetSource={openDrawer?.presetSource}
          onSaved={() => {
            closeDrawer();
            void load();
          }}
        />
      ) : null}
    </ListPageLayout>
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
function subscribeOrigin(): () => void {
  return () => {};
}
function readOrigin(): string {
  return window.location.origin;
}
function serverOrigin(): string {
  return "";
}

function OauthSetupBox({
  source,
  setup,
}: {
  source: string;
  setup: NonNullable<SourceTypeDef["oauthSetup"]>;
}) {
  const t = useTranslations("sync");
  // The page origin is external browser state: subscribe to it instead of
  // copying it into state from an effect. The server snapshot keeps the
  // server and first client render on the empty string, as before.
  const origin = useSyncExternalStore(subscribeOrigin, readOrigin, serverOrigin);
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

export function ConnectionDrawer({
  open,
  onClose,
  sourceTypes,
  currencies,
  editing,
  presetSource,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  sourceTypes: SourceTypeDef[];
  currencies: Currency[];
  /** When set, the drawer edits this connection instead of creating one. */
  editing?: Connection | null;
  /** A new connection opened for this source (the migration assistant's connect link). */
  presetSource?: string;
  onSaved: () => void;
}) {
  const t = useTranslations("sync");
  const [source, setSource] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [mappingDrafts, setMappingDrafts] = useState<MappingDrafts>({});
  const [drawerTab, setDrawerTab] = useState<"general" | "content" | "mappings">("general");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [postedChangePolicy, setPostedChangePolicy] = useState<
    "review_required" | "append_only_automatic"
  >("review_required");
  const [saving, setSaving] = useState(false);

  // Prefill from the edited connection (or clear for a fresh add) on open,
  // during render (same committed values, no extra render). A closing drawer
  // resets nothing, like before.
  const [prevDrawerKeys, setPrevDrawerKeys] = useState(() => ({ open, editing }));
  if (prevDrawerKeys.open !== open || prevDrawerKeys.editing !== editing) {
    setPrevDrawerKeys({ open, editing });
    if (open) { setDrawerTab("general"); setMappingDrafts({}); }
    if (!open) {
      // retain the form while closed
    } else if (editing) {
      setSource(editing.source);
      setDisplayName(editing.displayName);
      setConfig(
        Object.fromEntries(
          Object.entries(editing.config ?? {})
            // Callback-owned OAuth identity (realmId, tenantId, companyId,
            // companyName) is written by the Connect flow and refused on
            // PATCH (OAUTH_IDENTITY_REFUSED) — it never enters the form.
            .filter(([k]) => !CALLBACK_OWNED_CONFIG_KEYS.has(k))
            .map(([k, v]) => [k, v ?? ""]),
        ),
      );
      setSecrets({});
      setPostedChangePolicy(editing.postedChangePolicy);
    } else {
      setSource(presetSource && sourceTypes.some((type) => type.source === presetSource) ? presetSource : "");
      setDisplayName("");
      setConfig({});
      setSecrets({});
      setPostedChangePolicy("review_required");
    }
  }
  const def = sourceTypes.find((s) => s.source === source);
  const settings = connectorSettings(source);
  const mappingGroups = def?.mappingGroups ?? settings.mappingGroups;
  const syncCapabilities = def?.syncCapabilities ?? settings.syncCapabilities;
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
      // Defense in depth beside the prefill filter: callback-owned OAuth
      // identity never leaves this drawer, so an edit of a connected OAuth
      // connection cannot trip OAUTH_IDENTITY_REFUSED.
      if (Object.values(mappingDrafts).some((draft) => draft.source || draft.target)) {
        setDrawerTab("mappings");
        throw new Error(t("drawer.mappings.finishDraft"));
      }
      validateConnectionMappings(config.mappingJson, mappingGroups);
      const selection = resolveSyncSelection(config.syncOptions, syncCapabilities);
      const editableConfig = Object.fromEntries(
        Object.entries({ ...config, syncOptions: selection }).filter(([k]) => !CALLBACK_OWNED_CONFIG_KEYS.has(k)),
      );
      const res = editing
        ? await fetch(`/api/platform/connections/${editing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              displayName,
              config: editableConfig,
              secrets: provided,
              postedChangePolicy,
            }),
          })
        : await fetch("/api/platform/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source,
              displayName,
              config: editableConfig,
              secrets: provided,
            }),
          });
      // The status is checked before the body is parsed: a non-JSON error
      // body must surface the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("toast.saveFailed")));
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
                setDrawerTab("general");
                setMappingDrafts({});
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
          <RecordTabs label={t("drawer.tabsLabel")} active={drawerTab} onChange={setDrawerTab}
            tabs={[
              { key: "general", label: t("drawer.tabs.general") },
              { key: "content", label: t("drawer.tabs.content") },
              { key: "mappings", label: t("drawer.tabs.mappings") },
            ]}>
            <div className="pt-4">
            {drawerTab === "general" ? <div className="space-y-4">
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

            {editing ? (
              <div className="rounded-md border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-900/40">
                <Label>{t("drawer.postedChanges.label")}</Label>
                <Select
                  value={postedChangePolicy}
                  onChange={(event) =>
                    setPostedChangePolicy(
                      event.target.value as
                        | "review_required"
                        | "append_only_automatic",
                    )
                  }
                >
                  <option value="review_required">
                    {t("drawer.postedChanges.review")}
                  </option>
                  <option value="append_only_automatic">
                    {t("drawer.postedChanges.automatic")}
                  </option>
                </Select>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {t("drawer.postedChanges.help")}
                </p>
              </div>
            ) : null}

            {def.configFields.filter((f) => f.kind !== "mappings" && f.key !== "mappingJson" && f.kind !== "sync-options").map((f) => (
              <div key={f.key}>
                <Label>
                  {fieldLabel(f)}
                  {f.required ? " *" : ""}
                </Label>
                {f.kind === "select" ? (
                  <Select
                    value={String(config[f.key] ?? "")}
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
                    value={String(config[f.key] ?? "")}
                    placeholder={f.placeholder}
                    rows={10}
                    className="font-mono text-xs"
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, [f.key]: e.target.value }))
                    }
                  />
                ) : (
                  <Input
                    value={String(config[f.key] ?? "")}
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
            </div> : drawerTab === "content" ? <ConnectionSyncContent capabilities={syncCapabilities} value={config.syncOptions}
              onChange={(value) => setConfig((config) => ({ ...config, syncOptions: value }))} />
              : <ConnectionMappings key={source} groups={mappingGroups} value={config.mappingJson} drafts={mappingDrafts}
                onDraftChange={(key, draft) => setMappingDrafts((drafts) => ({ ...drafts, [key]: draft }))}
                onChange={(value) => setConfig((config) => ({ ...config, mappingJson: value }))} />}
            </div>
          </RecordTabs>
        ) : null}
      </div>
    </Drawer>
  );
}
