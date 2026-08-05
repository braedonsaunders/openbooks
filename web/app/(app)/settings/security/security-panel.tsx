"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardContent, Input, Label } from "@openbooks/ui";

type MfaStatus = { enabled: boolean; recoveryCodesRemaining: number };
type Session = {
  id: string;
  authMethod: "password" | "oidc";
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
    cache: "no-store",
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "The security change could not be completed");
  return value;
}

export function SecurityPanel() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [setup, setSetup] = useState<{ secret: string; provisioningUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [mfa, sessionResult] = await Promise.all([
      jsonRequest("/api/auth/mfa"),
      jsonRequest("/api/auth/sessions"),
    ]);
    setStatus(mfa);
    setSessions(sessionResult.sessions);
  }, []);

  useEffect(() => { void reload().catch((error) => setMessage(error.message)); }, [reload]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardContent className="space-y-5 p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-950 dark:text-white">Authenticator MFA</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {status?.enabled
                ? `Enabled · ${status.recoveryCodesRemaining} recovery codes remain`
                : "Require a time-based code after password or SSO authentication."}
            </p>
          </div>

          {!status?.enabled && !setup ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="setup-password">Confirm your current password</Label>
                <Input
                  id="setup-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <Button disabled={busy || status === null || !password} onClick={() => void act(async () => {
                setSetup(await jsonRequest("/api/auth/mfa", {
                  method: "POST",
                  body: JSON.stringify({ password }),
                }));
                setPassword("");
              })}>
                Set up authenticator
              </Button>
            </div>
          ) : null}

          {setup && !status?.enabled ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
                <p className="text-sm font-medium text-slate-900 dark:text-white">Authenticator setup key</p>
                <code className="mt-2 block break-all font-mono text-sm text-teal-700 dark:text-teal-300">{setup.secret}</code>
                <p className="mt-2 text-xs text-slate-500">Add this key as a time-based (TOTP), six-digit account.</p>
                <p className="mt-1 text-xs text-slate-500">This setup expires in 10 minutes and after five incorrect confirmations.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-mfa">Confirm the six-digit code</Label>
                <Input id="confirm-mfa" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
              </div>
              <Button disabled={busy || !code} onClick={() => void act(async () => {
                const result = await jsonRequest("/api/auth/mfa", { method: "PUT", body: JSON.stringify({ code }) });
                setRecoveryCodes(result.recoveryCodes);
                setSetup(null);
                setCode("");
                await reload();
              })}>
                Enable MFA
              </Button>
            </div>
          ) : null}

          {status?.enabled ? (
            <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
              <div className="space-y-1.5">
                <Label htmlFor="security-code">Current authenticator or recovery code</Label>
                <Input id="security-code" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="disable-password">Password (required for either change)</Label>
                <Input id="disable-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
              <Button variant="outline" disabled={busy || !password || !code} onClick={() => void act(async () => {
                const result = await jsonRequest("/api/auth/mfa/recovery", { method: "POST", body: JSON.stringify({ password, code }) });
                setRecoveryCodes(result.recoveryCodes);
                setPassword("");
                setCode("");
                await reload();
              })}>
                Replace recovery codes
              </Button>
              <Button variant="destructive" disabled={busy || !password || !code} onClick={() => void act(async () => {
                await jsonRequest("/api/auth/mfa", { method: "DELETE", body: JSON.stringify({ password, code }) });
                setPassword("");
                setCode("");
                setRecoveryCodes(null);
                await reload();
              })}>
                Disable MFA
              </Button>
            </div>
          ) : null}

          {recoveryCodes ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status">
              <p className="font-semibold">Save these recovery codes now</p>
              <p className="mt-1 text-sm">Each code works once. They will not be shown again.</p>
              <pre className="mt-3 grid grid-cols-2 gap-1 whitespace-pre-wrap font-mono text-sm">{recoveryCodes.join("\n")}</pre>
              <Button className="mt-3" variant="outline" onClick={() => void navigator.clipboard.writeText(recoveryCodes.join("\n"))}>
                Copy codes
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-950 dark:text-white">Active sessions</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Revoke a browser session without changing your password.</p>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {sessions.map((session) => (
              <div key={session.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-white">
                    {session.current ? "This session" : "Browser session"} · {session.authMethod.toUpperCase()}
                  </p>
                  <p className="text-xs text-slate-500">Last used {new Date(session.lastSeenAt).toLocaleString()}</p>
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => {
                  await jsonRequest(`/api/auth/sessions/${session.id}`, { method: "DELETE" });
                  if (session.current) window.location.assign("/login");
                  else await reload();
                })}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
          {sessions.length > 1 ? (
            <Button variant="outline" disabled={busy} onClick={() => void act(async () => {
              await jsonRequest("/api/auth/sessions", { method: "DELETE" });
              await reload();
            })}>
              Revoke all other sessions
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {message ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{message}</p> : null}
    </div>
  );
}
