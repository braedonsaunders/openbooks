"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
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

export async function jsonRequest(url: string, init: RequestInit | undefined, requestFailed: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
      cache: "no-store",
    });
  } catch {
    throw new Error(requestFailed);
  }
  if (!response.ok) throw new Error(requestFailed);
  return response.json().catch(() => ({}));
}

export function SecurityPanel() {
  const t = useTranslations("shell.securityPage");
  const requestFailed = t("requestFailed");
  const tCommon = useTranslations("common");
  const { dateTime } = useViewerFormat();
  const router = useRouter();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; provisioningUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const reload = useCallback(() => {
    return Promise.all([
      jsonRequest("/api/auth/mfa", undefined, requestFailed),
      jsonRequest("/api/auth/sessions", undefined, requestFailed),
    ]).then(([mfa, sessionResult]) => {
      setStatus(mfa);
      setSessions(sessionResult.sessions);
    });
  }, [requestFailed]);

  useEffect(() => {
    void reload().then(
      () => setLoaded(true),
      () => {
        setMessage(requestFailed);
        setLoaded(true);
      },
    );
  }, [reload, requestFailed]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch {
      setMessage(requestFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardContent className="space-y-5 p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-950 dark:text-white">{t("authenticatorTitle")}</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {!loaded
                ? tCommon("feedback.loading")
                : status?.enabled
                  ? t("enabled", { count: status.recoveryCodesRemaining })
                  : t("disabledDescription")}
            </p>
          </div>

          {loaded && !status?.enabled && !setup ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="setup-password">{t("confirmPassword")}</Label>
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
                }, requestFailed));
                setPassword("");
              })}>
                {t("setupAuthenticator")}
              </Button>
            </div>
          ) : null}

          {setup && !status?.enabled ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
                <p className="text-sm font-medium text-slate-900 dark:text-white">{t("setupKey")}</p>
                <code className="mt-2 block break-all font-mono text-sm text-teal-700 dark:text-teal-300">{setup.secret}</code>
                <p className="mt-2 text-xs text-slate-500">{t("setupKeyHelp")}</p>
                <p className="mt-1 text-xs text-slate-500">{t("setupExpiry")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-mfa">{t("confirmCode")}</Label>
                <Input id="confirm-mfa" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
              </div>
              <Button disabled={busy || !code} onClick={() => void act(async () => {
                const result = await jsonRequest("/api/auth/mfa", { method: "PUT", body: JSON.stringify({ code }) }, requestFailed);
                setRecoveryCodes(result.recoveryCodes);
                setSetup(null);
                setCode("");
                await reload();
              })}>
                {t("enableMfa")}
              </Button>
            </div>
          ) : null}

          {status?.enabled ? (
            <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
              <div className="space-y-1.5">
                <Label htmlFor="security-code">{t("currentCode")}</Label>
                <Input id="security-code" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="disable-password">{t("passwordRequired")}</Label>
                <Input id="disable-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
              <Button variant="outline" disabled={busy || !password || !code} onClick={() => void act(async () => {
                const result = await jsonRequest("/api/auth/mfa/recovery", { method: "POST", body: JSON.stringify({ password, code }) }, requestFailed);
                setRecoveryCodes(result.recoveryCodes);
                setPassword("");
                setCode("");
                await reload();
              })}>
                {t("replaceRecoveryCodes")}
              </Button>
              <Button variant="destructive" disabled={busy || !password || !code} onClick={() => void act(async () => {
                await jsonRequest("/api/auth/mfa", { method: "DELETE", body: JSON.stringify({ password, code }) }, requestFailed);
                setPassword("");
                setCode("");
                setRecoveryCodes(null);
                await reload();
              })}>
                {t("disableMfa")}
              </Button>
            </div>
          ) : null}

          {recoveryCodes ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status">
              <p className="font-semibold">{t("saveRecoveryCodes")}</p>
              <p className="mt-1 text-sm">{t("recoveryCodesHelp")}</p>
              <pre className="mt-3 grid grid-cols-2 gap-1 whitespace-pre-wrap font-mono text-sm">{recoveryCodes.join("\n")}</pre>
              <Button className="mt-3" variant="outline" onClick={() => void navigator.clipboard.writeText(recoveryCodes.join("\n"))}>
                {t("copyCodes")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-950 dark:text-white">{t("sessionsTitle")}</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("sessionsDescription")}</p>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {!loaded ? (
              <p className="py-3 text-sm text-slate-500 dark:text-slate-400">{tCommon("feedback.loading")}</p>
            ) : (
              sessions.map((session) => (
              <div key={session.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="inline-flex gap-1 text-sm font-medium text-slate-900 dark:text-white">
                    <span>{session.current ? t("thisSession") : t("browserSession")}</span>
                    <span>{session.authMethod.toUpperCase()}</span>
                  </p>
                  <p className="text-xs text-slate-500">{t("lastUsed", { date: dateTime(new Date(session.lastSeenAt)) })}</p>
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => {
                  await jsonRequest(`/api/auth/sessions/${session.id}`, { method: "DELETE" }, requestFailed);
                  if (session.current) router.push("/login");
                  else await reload();
                })}>
                  {t("revoke")}
                </Button>
              </div>
              ))
            )}
          </div>
          {loaded && sessions.length > 1 ? (
            <Button variant="outline" disabled={busy} onClick={() => void act(async () => {
              await jsonRequest("/api/auth/sessions", { method: "DELETE" }, requestFailed);
              await reload();
            })}>
              {t("revokeOtherSessions")}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {message ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{message}</p> : null}
    </div>
  );
}
