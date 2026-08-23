"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";
import {
  BANK_COUNTRIES,
  BANK_DIRECTORY,
  PROVIDER_CREDENTIALS,
  PROVIDER_LABEL,
  type BankDirectoryEntry,
  type FeedProvider,
} from "../../../../../lib/bank-directory";

interface Connection {
  id: string;
  name: string;
  provider: string;
  accountId: string;
  status: string;
  externalAccountId: string | null;
  syncCadence: string;
  lastSyncAt: string | null;
  lastError: string | null;
  isActive: boolean;
  accountNumber: string | null;
  accountName: string | null;
}
interface SftpServer {
  id: string;
  name: string;
  username: string;
  rootPrefix: string;
  isActive: boolean;
  lastConnectedAt: string | null;
}
interface SftpSchedule {
  id: string;
  sftpServerId: string;
  accountId: string;
  folder: string;
  format: string;
  isActive: boolean;
  lastRunAt: string | null;
  accountNumber: string | null;
  accountName: string | null;
}
interface Account { id: string; label: string }
interface Daemon { enabled: boolean; port: number; host: string; fingerprint: string }

const API_PROVIDERS = new Set<FeedProvider>(["plaid", "gocardless", "truelayer"]);

// --- little visual atoms -----------------------------------------------------

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function BankAvatar({ name, color, size = 40 }: { name: string; color: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl font-semibold text-white"
      style={{ background: color, width: size, height: size, fontSize: size * 0.35 }}
    >
      {initials(name)}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "connected"
      ? "bg-emerald-500"
      : status === "error"
        ? "bg-red-500"
        : status === "pending"
          ? "bg-amber-400"
          : "bg-slate-300";
  return <span className={`inline-block h-2 w-2 rounded-full ${tone}`} />;
}

const PROVIDER_COLOR: Record<string, string> = {
  plaid: "#111111",
  gocardless: "#F1F252",
  truelayer: "#1B0B34",
  sftp: "#0F766E",
  manual: "#64748B",
};

/** How each method works, shown as an explainer at the top of the configure step. */
const METHOD_HELP: Record<
  string,
  { kind: "live" | "fileDrop" | "manual"; docsUrl?: string }
> = {
  plaid: { kind: "live", docsUrl: "https://dashboard.plaid.com/developers/keys" },
  gocardless: {
    kind: "live",
    docsUrl: "https://bankaccountdata.gocardless.com/overview/",
  },
  truelayer: { kind: "live", docsUrl: "https://console.truelayer.com/" },
  sftp: { kind: "fileDrop" },
  manual: { kind: "manual" },
};

// --- main --------------------------------------------------------------------

export function BankFeedsClient({
  connections,
  sftpServers,
  sftpSchedules,
  accounts,
  daemon,
}: {
  connections: Connection[];
  sftpServers: SftpServer[];
  sftpSchedules: SftpSchedule[];
  accounts: Account[];
  daemon: Daemon;
}) {
  const router = useRouter();
  const t = useTranslations("banking.bankFeeds.client");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const schedulesByServer = useMemo(() => {
    const m = new Map<string, SftpSchedule[]>();
    for (const s of sftpSchedules) (m.get(s.sftpServerId) ?? m.set(s.sftpServerId, []).get(s.sftpServerId)!).push(s);
    return m;
  }, [sftpSchedules]);

  const totalConnections = connections.length + sftpServers.length;

  const refresh = () => router.refresh();

  const feedAction = async (id: string, action: "test" | "sync") => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/banking/bank-feeds/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const b = await r.json().catch(() => ({}));
    setBusy(false);
    setMsg(
      action === "test"
        ? b.ok
          ? t("feedMessages.verified")
          : t("feedMessages.testFailed", {
              detail: b.detail ?? t("feedMessages.unknownError"),
            })
        : b.error
          ? t("feedMessages.syncFailed", { error: b.error })
          : t("feedMessages.imported", {
              imported: b.imported,
              duplicates: b.duplicates,
            }),
    );
    refresh();
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-1">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t("title")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            {t("description")}
          </p>
        </div>
        {!adding && (
          <Button onClick={() => { setAdding(true); setMsg(null); }} className="shrink-0">{t("addConnection")}</Button>
        )}
      </div>

      {msg && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-300">
          {msg}
        </div>
      )}

      {adding && (
        <AddConnectionFlow
          accounts={accounts}
          daemon={daemon}
          onClose={() => setAdding(false)}
          onDone={(m) => { setAdding(false); setMsg(m); refresh(); }}
        />
      )}

      {/* Unified connection list */}
      {totalConnections === 0 && !adding ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <div className="text-sm text-slate-500 dark:text-slate-400">{t("empty.none")}</div>
          <Button onClick={() => setAdding(true)}>{t("empty.connectFirst")}</Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {connections.map((c) => {
            const dirColor = PROVIDER_COLOR[c.provider] ?? "#64748B";
            return (
              <Card key={c.id} className="flex items-center gap-4 p-4">
                <BankAvatar name={c.name} color={dirColor} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-slate-900 dark:text-slate-100">{c.name}</span>
                    <Badge variant="secondary">{PROVIDER_LABEL[c.provider as FeedProvider] ?? c.provider}</Badge>
                    {!c.isActive && <span className="text-xs text-slate-400">{t("connection.paused")}</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <StatusDot status={c.status} />
                    <span className="capitalize">{c.status}</span>
                    <span>·</span>
                    <span className="font-mono">{c.accountNumber}</span>
                    <span className="truncate">{c.accountName}</span>
                    {c.lastSyncAt && <><span>·</span><span>{t("connection.synced", { date: new Date(c.lastSyncAt).toLocaleDateString("en-CA") })}</span></>}
                  </div>
                  {c.lastError && <div className="mt-1 truncate text-xs text-red-600" title={c.lastError}>⚠ {c.lastError}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {API_PROVIDERS.has(c.provider as FeedProvider) && (
                    <>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => feedAction(c.id, "test")}>{t("connection.test")}</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => feedAction(c.id, "sync")}>{t("connection.sync")}</Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={async () => { await fetch(`/api/banking/bank-feeds/${c.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: !c.isActive }) }); refresh(); }}>
                    {c.isActive ? t("connection.pause") : t("connection.resume")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={async () => { await fetch(`/api/banking/bank-feeds/${c.id}`, { method: "DELETE" }); refresh(); }}>{t("connection.remove")}</Button>
                </div>
              </Card>
            );
          })}

          {sftpServers.map((s) => (
            <SftpConnectionCard
              key={s.id}
              server={s}
              schedules={schedulesByServer.get(s.id) ?? []}
              accounts={accounts}
              onChange={refresh}
            />
          ))}
        </div>
      )}

      {/* Shared SFTP receiving endpoint — only relevant once SFTP logins exist. */}
      {sftpServers.length > 0 && <SftpEndpointCard daemon={daemon} />}
    </div>
  );
}

// --- SFTP connection card (server + its routing) -----------------------------

function SftpConnectionCard({
  server,
  schedules,
  accounts,
  onChange,
}: {
  server: SftpServer;
  schedules: SftpSchedule[];
  accounts: Account[];
  onChange: () => void;
}) {
  const [routing, setRouting] = useState(false);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [folder, setFolder] = useState("inbound");
  const t = useTranslations("banking.bankFeeds.client");

  return (
    <Card className="p-4">
      <div className="flex items-center gap-4">
        <BankAvatar name={server.name} color={PROVIDER_COLOR.sftp} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-slate-900 dark:text-slate-100">{server.name}</span>
            <Badge variant="secondary">{t("sftpCard.badge")}</Badge>
            {!server.isActive && <span className="text-xs text-slate-400">{t("connection.paused")}</span>}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {t("sftpCard.login")} <span className="font-mono">{server.username}</span>
            {schedules.length > 0 && <> · {t("sftpCard.routesTo", { count: schedules.length })}</>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setRouting(!routing)}>{routing ? t("sftpCard.done") : t("sftpCard.routing")}</Button>
          <Button size="sm" variant="ghost" onClick={async () => { await fetch(`/api/banking/sftp/${server.id}`, { method: "DELETE" }); onChange(); }}>{t("sftpCard.remove")}</Button>
        </div>
      </div>

      {(routing || schedules.length > 0) && (
        <div className="mt-3 rounded-lg border border-slate-100 p-3 dark:border-slate-800">
          <div className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">{t("sftpCard.routingTitle")}</div>
          <ul className="space-y-1 text-sm">
            {schedules.map((sc) => (
              <li key={sc.id} className="flex items-center gap-2">
                <span className="font-mono text-xs">/{sc.folder}</span>
                <span className="text-slate-400">→</span>
                <span className="font-mono text-xs">{sc.accountNumber}</span>
                <span className="text-slate-500">{sc.accountName}</span>
                <Badge variant="outline">{sc.format}</Badge>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={async () => { await fetch(`/api/banking/sftp/schedules/${sc.id}`, { method: "DELETE" }); onChange(); }}>{t("sftpCard.remove")}</Button>
              </li>
            ))}
            {schedules.length === 0 && <li className="text-xs text-slate-400">{t("sftpCard.noRouting")}</li>}
          </ul>
          {routing && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t("sftpCard.folderPlaceholder")} className="h-8 w-28" />
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="h-8 max-w-xs">
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </Select>
              <Button size="sm" disabled={!accountId} onClick={async () => {
                await fetch("/api/banking/sftp/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sftpServerId: server.id, accountId, folder, format: "auto" }) });
                onChange();
              }}>{t("sftpCard.addRoute")}</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SftpEndpointCard({ daemon }: { daemon: Daemon }) {
  const t = useTranslations("banking.bankFeeds.client.sftpEndpoint");
  return (
    <Card className="p-4">
      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t("title")}</div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("description")}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-400">{t("host")}</dt><dd className="font-mono">{daemon.host}</dd>
        <dt className="text-slate-400">{t("port")}</dt><dd className="font-mono">{daemon.port}</dd>
        <dt className="text-slate-400">{t("status")}</dt><dd>{daemon.enabled ? <span className="text-emerald-600">{t("enabled")}</span> : <span className="text-slate-400">{t("disabled")}</span>}</dd>
        <dt className="text-slate-400">{t("hostKey")}</dt><dd className="truncate font-mono text-xs">{daemon.fingerprint}</dd>
      </dl>
    </Card>
  );
}

// --- Add connection flow -----------------------------------------------------

function AddConnectionFlow({
  accounts,
  daemon,
  onClose,
  onDone,
}: {
  accounts: Account[];
  daemon: Daemon;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");
  const [selected, setSelected] = useState<
    | { kind: "bank"; bank: BankDirectoryEntry }
    | { kind: "sftp" }
    | { kind: "manual" }
    | { kind: "other" }
    | null
  >(null);
  const t = useTranslations("banking.bankFeeds.client.chooseBank");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BANK_DIRECTORY.filter(
      (b) => (!country || b.country === country) && (!q || b.name.toLowerCase().includes(q)),
    );
  }, [query, country]);

  if (selected) {
    return (
      <ConfigureConnection
        selection={selected}
        accounts={accounts}
        daemon={daemon}
        onBack={() => setSelected(null)}
        onCancel={onClose}
        onDone={onDone}
      />
    );
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>{t("cancel")}</Button>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="max-w-xs" />
        <Select value={country} onChange={(e) => setCountry(e.target.value)} className="max-w-[12rem]">
          <option value="">{t("allCountries")}</option>
          {BANK_COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {filtered.map((b) => (
          <button
            key={b.id}
            onClick={() => setSelected({ kind: "bank", bank: b })}
            className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-left transition hover:border-teal-400 hover:bg-teal-50/40 dark:border-slate-800 dark:hover:border-teal-600 dark:hover:bg-teal-950/30"
          >
            <BankAvatar name={b.name} color={b.brandColor} size={32} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{b.name}</div>
              <div className="text-xs text-slate-400">{PROVIDER_LABEL[b.provider]}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="mb-2 text-xs font-medium text-slate-400">{t("notListed")}</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <FallbackTile label={t("otherBank")} hint={t("otherBankHint")} onClick={() => setSelected({ kind: "other" })} />
          <FallbackTile label={t("sftpDrop")} hint={t("sftpDropHint")} onClick={() => setSelected({ kind: "sftp" })} />
          <FallbackTile label={t("manualUpload")} hint={t("manualUploadHint")} onClick={() => setSelected({ kind: "manual" })} />
        </div>
      </div>
    </Card>
  );
}

function FallbackTile({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-lg border border-slate-200 p-3 text-left transition hover:border-teal-400 hover:bg-teal-50/40 dark:border-slate-800 dark:hover:border-teal-600 dark:hover:bg-teal-950/30">
      <div className="text-sm font-medium">{label}</div>
      <div className="text-xs text-slate-400">{hint}</div>
    </button>
  );
}

function ConfigureConnection({
  selection,
  accounts,
  daemon,
  onBack,
  onCancel,
  onDone,
}: {
  selection: { kind: "bank"; bank: BankDirectoryEntry } | { kind: "sftp" } | { kind: "manual" } | { kind: "other" };
  accounts: Account[];
  daemon: Daemon;
  onBack: () => void;
  onCancel: () => void;
  onDone: (msg: string) => void;
}) {
  const bank = selection.kind === "bank" ? selection.bank : null;
  const [provider, setProvider] = useState<FeedProvider>(
    selection.kind === "bank" ? selection.bank.provider
      : selection.kind === "sftp" ? "sftp"
        : selection.kind === "manual" ? "manual"
          : "gocardless",
  );
  const [name, setName] = useState(bank?.name ?? "");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sftpSecret, setSftpSecret] = useState<{ username: string; password: string } | null>(null);
  const t = useTranslations("banking.bankFeeds.client");

  const isApi = API_PROVIDERS.has(provider);
  const color = bank?.brandColor ?? PROVIDER_COLOR[provider] ?? "#64748B";

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      if (provider === "sftp") {
        const r = await fetch("/api/banking/sftp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name || "SFTP feed" }),
        });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) { setError(b.error ?? t("errors.couldNotCreateSftp")); setBusy(false); return; }
        // Optionally route to the chosen account immediately.
        if (accountId) {
          await fetch("/api/banking/sftp/schedules", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sftpServerId: b.id, accountId, folder: "inbound", format: "auto" }),
          });
        }
        setBusy(false);
        setSftpSecret({ username: b.username, password: b.password });
        return; // keep the panel open to show the one-time password
      }
      const r = await fetch("/api/banking/bank-feeds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name || bank?.name || "Bank feed",
          provider,
          accountId,
          externalAccountId: isApi ? externalAccountId : null,
          syncCadence: cadence,
          credentials: isApi ? creds : null,
        }),
      });
      const b = await r.json().catch(() => ({}));
      setBusy(false);
      if (!r.ok) { setError(b.error ?? t("errors.couldNotCreateConnection")); return; }
      onDone(t("sftpSecret.addedToast", { name: name || bank?.name || "Connection" }));
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : t("errors.failed"));
    }
  };

  if (sftpSecret) {
    return (
      <Card className="p-5">
        <h3 className="text-sm font-semibold">{t("sftpSecret.title")}</h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("sftpSecret.description")}</p>
        <div className="mt-3 space-y-1 rounded-lg bg-slate-50 p-3 font-mono text-sm dark:bg-slate-900">
          <div>{t("sftpSecret.hostLabel")} {daemon.host}</div>
          <div>{t("sftpSecret.portLabel")} {daemon.port}</div>
          <div>{t("sftpSecret.usernameLabel")} {sftpSecret.username}</div>
          <div>{t("sftpSecret.passwordLabel")} {sftpSecret.password}</div>
        </div>
        <div className="mt-4"><Button onClick={() => onDone(t("sftpSecret.createdToast"))}>{t("sftpSecret.done")}</Button></div>
      </Card>
    );
  }

  const help = METHOD_HELP[provider];

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-3">
        <Button size="sm" variant="ghost" onClick={onBack}>{t("configure.back")}</Button>
        <BankAvatar name={name || "Bank"} color={color} size={32} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{bank?.name ?? t("configure.newConnection")}</div>
          <div className="text-xs text-slate-400">
            {help?.kind === "live" ? t("configure.kindLive") : help?.kind === "fileDrop" ? t("configure.kindFileDrop") : help?.kind === "manual" ? t("configure.kindManual") : null}
            {" · "}
            {PROVIDER_LABEL[provider]}
          </div>
        </div>
      </div>

      {/* Provider picker first for the "other" path, so the explainer matches. */}
      {selection.kind === "other" && (
        <div className="mb-4">
          <Label>{t("configure.providerQuestion")}</Label>
          <Select value={provider} onChange={(e) => setProvider(e.target.value as FeedProvider)} className="max-w-xs">
            <option value="gocardless">{t("configure.providerGocardless")}</option>
            <option value="plaid">{t("configure.providerPlaid")}</option>
            <option value="truelayer">{t("configure.providerTruelayer")}</option>
          </Select>
        </div>
      )}

      {/* What this method actually does. */}
      {help && (
        <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          <div className="mb-1 flex items-center gap-2">
            <StatusDot status="pending" />
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {help.kind === "live"
                ? t("configure.explainerAutoFeed", { provider: PROVIDER_LABEL[provider] })
                : help.kind === "fileDrop"
                  ? t("configure.explainerSftp")
                  : t("configure.explainerManual")}
            </span>
          </div>
          <p>{t(`method.${provider}.blurb`)}</p>
          {help.docsUrl && (
            <a href={help.docsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-teal-700 hover:underline dark:text-teal-300">
              {t(`method.${provider}.docsLabel`)} ↗
            </a>
          )}
        </div>
      )}

      {/* Step 1 — what it feeds. Common to every method. */}
      <div className="space-y-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("configure.stepAccount")}</div>
        <div className="grid gap-3 pt-1 sm:grid-cols-2">
          <div>
            <Label>{t("configure.connectionName")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("configure.connectionNamePlaceholder")} />
          </div>
          <div>
            <Label>{t("configure.bankGlAccount")}</Label>
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </Select>
          </div>
        </div>
      </div>

      {/* Step 2 — method-specific configuration. */}
      {isApi && (
        <div className="mt-5 space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("configure.credentialsStep", { provider: PROVIDER_LABEL[provider] })}</div>
          <div className="grid gap-3 pt-1 sm:grid-cols-2">
            {(PROVIDER_CREDENTIALS[provider] ?? []).map((f) => (
              <div key={f.key}>
                <Label>{f.label}</Label>
                <Input type={f.secret ? "password" : "text"} value={creds[f.key] ?? ""} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} />
              </div>
            ))}
            <div>
              <Label>{t("configure.providerAccountId")}</Label>
              <Input value={externalAccountId} onChange={(e) => setExternalAccountId(e.target.value)} placeholder={t("configure.providerAccountIdPlaceholder")} />
            </div>
            <div>
              <Label>{t("configure.importHowOften")}</Label>
              <Select value={cadence} onChange={(e) => setCadence(e.target.value)}>
                <option value="daily">{t("configure.cadenceDaily")}</option>
                <option value="hourly">{t("configure.cadenceHourly")}</option>
                <option value="manual">{t("configure.cadenceManual")}</option>
              </Select>
            </div>
          </div>
        </div>
      )}

      {provider === "sftp" && (
        <div className="mt-5 space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("configure.sftpStepTitle")}</div>
          <p className="pt-1 text-xs text-slate-500 dark:text-slate-400">
            {t.rich("configure.sftpStepHelp", {
              inbound: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      <div className="mt-5 flex gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        <Button onClick={save} disabled={busy || !accountId || (!name && !bank)}>
          {provider === "sftp" ? t("configure.createSftpLogin") : t("configure.addConnection")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t("configure.cancel")}</Button>
      </div>
    </Card>
  );
}
