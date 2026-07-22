"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";

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
  hasCredentials: boolean;
  accountNumber: string | null;
  accountName: string | null;
}

interface Account {
  id: string;
  label: string;
}

const PROVIDERS = [
  { value: "manual", label: "Manual upload" },
  { value: "sftp", label: "SFTP file drop" },
  { value: "gocardless", label: "GoCardless / Nordigen" },
  { value: "plaid", label: "Plaid" },
  { value: "truelayer", label: "TrueLayer" },
];

// Which credential fields each API provider needs.
const CRED_FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  gocardless: [
    { key: "secretId", label: "Secret ID" },
    { key: "secretKey", label: "Secret key", secret: true },
  ],
  plaid: [
    { key: "clientId", label: "Client ID" },
    { key: "secret", label: "Secret", secret: true },
    { key: "accessToken", label: "Access token", secret: true },
    { key: "env", label: "Environment (production/sandbox)" },
  ],
  truelayer: [{ key: "accessToken", label: "Access token", secret: true }],
};

const API_PROVIDERS = new Set(["gocardless", "plaid", "truelayer"]);

const STATUS_TONE: Record<string, "default" | "secondary"> = {
  connected: "default",
  pending: "secondary",
  error: "secondary",
  disconnected: "secondary",
};

export function BankFeedsClient({ connections, accounts }: { connections: Connection[]; accounts: Account[] }) {
  const router = useRouter();
  const [provider, setProvider] = useState("gocardless");
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isApi = API_PROVIDERS.has(provider);

  const create = async () => {
    setError(null);
    setMsg(null);
    setBusy(true);
    const r = await fetch("/api/banking/bank-feeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        provider,
        accountId,
        externalAccountId: isApi ? externalAccountId : null,
        syncCadence: cadence,
        credentials: isApi ? creds : null,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).error ?? "Could not create connection");
      return;
    }
    setName("");
    setExternalAccountId("");
    setCreds({});
    router.refresh();
  };

  const act = async (id: string, action: "test" | "sync") => {
    setMsg(null);
    setError(null);
    setBusy(true);
    const r = await fetch(`/api/banking/bank-feeds/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (action === "test") {
      setMsg(body.ok ? "Connection OK" : `Test failed: ${body.detail ?? "unknown error"}`);
    } else {
      setMsg(body.error ? `Sync failed: ${body.error}` : `Imported ${body.imported} new, ${body.duplicates} duplicate`);
    }
    router.refresh();
  };

  const patch = async (id: string, patchBody: Record<string, unknown>) => {
    await fetch(`/api/banking/bank-feeds/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patchBody),
    });
    router.refresh();
  };

  const remove = async (id: string) => {
    await fetch(`/api/banking/bank-feeds/${id}`, { method: "DELETE" });
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">New bank feed connection</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label>Provider</Label>
            <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
          </div>
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="RBC operating — daily" />
          </div>
          <div>
            <Label>Bank account</Label>
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </Select>
          </div>
          {isApi && (
            <>
              <div>
                <Label>Provider account id</Label>
                <Input value={externalAccountId} onChange={(e) => setExternalAccountId(e.target.value)} placeholder="account id at the provider" />
              </div>
              <div>
                <Label>Sync cadence</Label>
                <Select value={cadence} onChange={(e) => setCadence(e.target.value)}>
                  <option value="daily">Daily</option>
                  <option value="hourly">Hourly</option>
                  <option value="manual">Manual only</option>
                </Select>
              </div>
              {(CRED_FIELDS[provider] ?? []).map((f) => (
                <div key={f.key}>
                  <Label>{f.label}</Label>
                  <Input
                    type={f.secret ? "password" : "text"}
                    value={creds[f.key] ?? ""}
                    onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })}
                  />
                </div>
              ))}
            </>
          )}
          {provider === "sftp" && (
            <p className="self-end text-xs text-muted-foreground sm:col-span-2">
              Configure the file endpoint and import folders on the SFTP tabs above.
            </p>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-3">
          <Button onClick={create} disabled={busy || !name || !accountId}>Add connection</Button>
        </div>
      </Card>

      {msg && <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2">Connection</th><th>Provider</th><th>Account</th>
              <th>Cadence</th><th>Last sync</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id} className="border-t align-top">
                <td className="py-2 font-medium">{c.name}</td>
                <td>{c.provider}</td>
                <td>{[c.accountNumber, c.accountName].filter(Boolean).join(" · ")}</td>
                <td>{c.syncCadence}</td>
                <td>
                  {c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleDateString() : "—"}
                  {c.lastError && <span className="ml-1 text-red-600" title={c.lastError}>⚠</span>}
                </td>
                <td>
                  <Badge variant={STATUS_TONE[c.status] ?? "secondary"}>{c.status}</Badge>
                  {!c.isActive && <span className="ml-1 text-xs text-muted-foreground">(paused)</span>}
                </td>
                <td className="whitespace-nowrap text-right">
                  {API_PROVIDERS.has(c.provider) && (
                    <>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(c.id, "test")}>Test</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(c.id, "sync")}>Sync now</Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => patch(c.id, { isActive: !c.isActive })}>
                    {c.isActive ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(c.id)}>Delete</Button>
                </td>
              </tr>
            ))}
            {connections.length === 0 && (
              <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">No bank feed connections yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
