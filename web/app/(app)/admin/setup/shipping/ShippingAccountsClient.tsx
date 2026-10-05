"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Badge, Button, Card, CardContent, EmptyState, Input, Label, Select } from "@openbooks/ui";
import { Switch } from "@/components/switch";
import { readApiErrorMessage } from "../../../../../lib/api-error";
import { confirmDialog } from "../../../../../lib/confirm";
import { useAppAction } from "../../../../../lib/use-app-action";

type ProviderKey = "easypost" | "shippo";

type Account = {
  id: string;
  name: string;
  provider: string;
  mode: string;
  status: string;
  isDefault: boolean;
  hasKey: boolean;
  hasRelaySecret: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
};

type ConnectResponse = { connected?: { accountId: string; relaySecret: string | null } };

const PROVIDERS: { key: ProviderKey; label: string }[] = [
  { key: "easypost", label: "EasyPost" },
  { key: "shippo", label: "Shippo" },
];

function statusVariant(status: string): "success" | "destructive" | "secondary" {
  if (status === "active") return "success";
  if (status === "error") return "destructive";
  return "secondary";
}

function useStatusLabel(): (status: string) => string {
  const t = useTranslations("admin.setup.shipping");
  return (status: string) => {
    if (status === "active") return t("accounts.status.active");
    if (status === "disabled") return t("accounts.status.disabled");
    if (status === "error") return t("accounts.status.error");
    return status;
  };
}

/**
 * Carrier accounts tab of Company Settings → Shipping. Connects an
 * aggregator account with its API key (sealed on the way in, never shown
 * again), tests the connection end to end, and parks accounts without
 * deleting their labels or cost history. The key field is blank on edit:
 * saving without one keeps the stored key.
 */
export function ShippingAccountsClient() {
  const t = useTranslations("admin.setup.shipping");
  const tc = useTranslations("common");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderKey>("easypost");
  const [mode, setMode] = useState<"test" | "live">("test");
  const [apiKey, setApiKey] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  // A relay secret is returned once, on connect or rotation; it is held here
  // only until the operator confirms they configured the delivery sender.
  const [issuedSecret, setIssuedSecret] = useState<{ name: string; secret: string } | null>(null);
  const { busy, refusal, execute } = useAppAction();
  const statusLabel = useStatusLabel();

  const load = useCallback(async () => {
    const res = await fetch("/api/shipping/accounts");
    if (!res.ok) {
      setError(await readApiErrorMessage(res, t("accounts.errors.loadFailed")));
      setAccounts([]);
      return;
    }
    const body = (await res.json()) as { accounts?: Account[] };
    setAccounts(body.accounts ?? []);
    setError(null);
  }, [t]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function startAdd() {
    setEditingId(null);
    setName("");
    setProvider("easypost");
    setMode("test");
    setApiKey("");
    setMakeDefault((accounts ?? []).length === 0);
    setAdding(true);
  }

  function startEdit(account: Account) {
    setAdding(false);
    setEditingId(account.id);
    setName(account.name);
    setProvider(account.provider === "shippo" ? "shippo" : "easypost");
    setMode(account.mode === "live" ? "live" : "test");
    setApiKey("");
    setMakeDefault(account.isDefault);
  }

  function cancelForm() {
    setAdding(false);
    setEditingId(null);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const savedName = name.trim();
    await execute(
      () =>
        fetchAction<ConnectResponse>("/api/shipping/accounts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(editingId ? { accountId: editingId } : {}),
            name: name.trim(),
            provider,
            mode,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            makeDefault,
          }),
        }),
      {
        fallbackMessage: t("accounts.errors.saveFailed"),
        successMessage: t(editingId ? "accounts.updated" : "accounts.connected"),
        onOk: (data) => {
          if (data?.connected?.relaySecret) setIssuedSecret({ name: savedName, secret: data.connected.relaySecret });
          cancelForm();
          void load();
        },
      },
    );
  }

  async function testConnection(account: Account) {
    await execute(
      () => fetchAction(`/api/shipping/accounts/${encodeURIComponent(account.id)}/test`, { method: "POST" }),
      {
        fallbackMessage: t("accounts.errors.testFailed"),
        successMessage: t("accounts.testOk", { name: account.name }),
        onOk: () => {
          void load();
        },
      },
    );
  }

  async function rotateRelaySecret(account: Account) {
    if (account.hasRelaySecret && !(await confirmDialog(t("accounts.relaySecretRotateConfirm", { name: account.name })))) return;
    await execute(
      () =>
        fetchAction<ConnectResponse>(`/api/shipping/accounts/${encodeURIComponent(account.id)}/relay-secret`, { method: "POST" }),
      {
        fallbackMessage: t("accounts.errors.saveFailed"),
        successMessage: t("accounts.relaySecretRotated", { name: account.name }),
        onOk: (data) => {
          if (data?.connected?.relaySecret) setIssuedSecret({ name: account.name, secret: data.connected.relaySecret });
          void load();
        },
      },
    );
  }

  async function disconnect(account: Account) {
    if (!(await confirmDialog(t("accounts.disconnectConfirm", { name: account.name })))) return;
    await execute(
      () => fetchAction(`/api/shipping/accounts/${encodeURIComponent(account.id)}/disconnect`, { method: "POST" }),
      {
        fallbackMessage: t("accounts.errors.disconnectFailed"),
        successMessage: t("accounts.disconnected", { name: account.name }),
        onOk: () => {
          void load();
        },
      },
    );
  }

  const formOpen = adding || editingId !== null;
  const editing = editingId !== null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-1">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t("accounts.title")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t("accounts.description")}</p>
        </div>
        {!formOpen && (
          <Button onClick={startAdd} className="shrink-0">{t("accounts.connect")}</Button>
        )}
      </div>

      <ActionAlert error={refusal} fallbackMessage={t("accounts.errors.saveFailed")} />
      {issuedSecret && (
        <Card>
          <CardContent className="space-y-2 pt-4" role="status">
            <p className="font-medium text-slate-900 dark:text-slate-100">{t("accounts.relaySecretIssuedTitle", { name: issuedSecret.name })}</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">{t("accounts.relaySecretIssuedHint")}</p>
            <code className="block break-all rounded-md bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900 dark:bg-slate-900 dark:text-slate-100">{issuedSecret.secret}</code>
            <Button variant="outline" size="sm" onClick={() => setIssuedSecret(null)}>{t("accounts.relaySecretDismiss")}</Button>
          </CardContent>
        </Card>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {formOpen && (
        <Card>
          <CardContent>
            <form onSubmit={save} className="grid gap-4 pt-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="shipping-account-name">{t("accounts.name")}</Label>
                <Input
                  id="shipping-account-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("accounts.namePlaceholder")}
                  required
                  maxLength={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="shipping-account-provider">{t("accounts.provider")}</Label>
                <Select id="shipping-account-provider" value={provider} onChange={(event) => setProvider(event.target.value as ProviderKey)}>
                  {PROVIDERS.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="shipping-account-mode">{t("accounts.mode")}</Label>
                <Select id="shipping-account-mode" value={mode} onChange={(event) => setMode(event.target.value as "test" | "live")}>
                  <option value="test">{t("accounts.modeTest")}</option>
                  <option value="live">{t("accounts.modeLive")}</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="shipping-account-key">{t("accounts.apiKey")}</Label>
                <Input
                  id="shipping-account-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={editing ? t("accounts.keyKeepPlaceholder") : t("accounts.keyPlaceholder")}
                  required={!editing}
                  autoComplete="new-password"
                />
              </div>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Switch on={makeDefault} disabled={busy} onToggle={() => setMakeDefault((current) => !current)} label={t("accounts.makeDefault")} />
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={busy}>{editing ? tc("actions.save") : t("accounts.connect")}</Button>
                <Button type="button" variant="outline" onClick={cancelForm}>{tc("actions.cancel")}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {accounts === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{tc("labels.loading")}</p>
      ) : accounts.length === 0 ? (
        <EmptyState
          title={t("accounts.emptyTitle")}
          description={t("accounts.emptyDescription")}
          action={!formOpen ? <Button onClick={startAdd}>{t("accounts.connect")}</Button> : undefined}
        />
      ) : (
        <div className="space-y-3">
          {accounts.map((account) => (
            <Card key={account.id}>
              <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900 dark:text-slate-100">{account.name}</span>
                    {account.isDefault && <Badge variant="secondary">{t("accounts.defaultBadge")}</Badge>}
                    <Badge variant="outline">{account.provider === "shippo" ? "Shippo" : "EasyPost"}</Badge>
                    <Badge variant="outline">{account.mode === "live" ? t("accounts.modeLive") : t("accounts.modeTest")}</Badge>
                    <Badge variant={statusVariant(account.status)}>{statusLabel(account.status)}</Badge>
                    {!account.hasKey && <Badge variant="warning">{t("accounts.noKey")}</Badge>}
                    {!account.hasRelaySecret && <Badge variant="warning">{t("accounts.noRelaySecret")}</Badge>}
                  </div>
                  {account.lastError && (
                    <p className="mt-1 text-sm text-red-700 dark:text-red-300">{account.lastError}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void testConnection(account)}>
                    {t("accounts.test")}
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => startEdit(account)}>
                    {tc("actions.edit")}
                  </Button>
                  {account.status !== "disabled" && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void rotateRelaySecret(account)}>
                      {t(account.hasRelaySecret ? "accounts.relaySecretRotate" : "accounts.relaySecretGenerate")}
                    </Button>
                  )}
                  {account.status !== "disabled" && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect(account)}>
                      {t("accounts.disconnect")}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
