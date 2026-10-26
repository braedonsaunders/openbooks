"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
import { readApiErrorMessage } from "@/lib/api-error";
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

export function securityErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function jsonRequest(
  url: string,
  init: RequestInit | undefined,
  requestFailed: string,
  lockoutMessage?: (seconds: number) => string,
) {
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
  // A refusal carries its remedy in the body: the 409 names the pending
  // session ("MFA setup is already pending in another session; ..."), and
  // the 429 lockout carries its retryAfter. Collapsing either to the
  // generic text hides the only thing the operator can act on.
  if (!response.ok) {
    const message = await readApiErrorMessage(response.clone(), requestFailed);
    const body = (await response.json().catch(() => null)) as { retryAfter?: unknown } | null;
    const retryAfter =
      body && typeof body.retryAfter === "number" && Number.isFinite(body.retryAfter)
        ? Math.max(0, Math.ceil(body.retryAfter))
        : null;
    if (retryAfter !== null && lockoutMessage) throw new Error(lockoutMessage(retryAfter));
    throw new Error(message);
  }
  return response.json().catch(() => ({}));
}

const PASSWORD_REFUSAL_KEYS = {
  invalid_current_password: "passwordWrongCurrent",
  unchanged_password: "passwordUnchanged",
  weak_password: "passwordTooShort",
  busy: "passwordBusy",
} as const;

export type PasswordChangeRefusal =
  | { kind: "lockout"; seconds: number }
  | {
      kind: "copy";
      key: (typeof PASSWORD_REFUSAL_KEYS)[keyof typeof PASSWORD_REFUSAL_KEYS];
      min?: number;
    }
  | { kind: "text"; text: string };

/**
 * Classify a password-change refusal: a lockout carries its retry delay,
 * known refusal codes map to their own localized copy, and anything else
 * keeps the server's message. The minimum length is the server's policy,
 * carried on the refusal, never a second copy here.
 */
export async function passwordChangeRefusal(
  response: Response,
  requestFailed: string,
): Promise<PasswordChangeRefusal> {
  const message = await readApiErrorMessage(response.clone(), requestFailed);
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    retryAfter?: unknown;
    minLength?: unknown;
  } | null;
  if (body && typeof body.retryAfter === "number" && Number.isFinite(body.retryAfter)) {
    return { kind: "lockout", seconds: Math.max(0, Math.ceil(body.retryAfter)) };
  }
  const code = typeof body?.code === "string" ? body.code : null;
  if (!code || !Object.hasOwn(PASSWORD_REFUSAL_KEYS, code)) return { kind: "text", text: message };
  const key = PASSWORD_REFUSAL_KEYS[code as keyof typeof PASSWORD_REFUSAL_KEYS];
  if (key !== "passwordTooShort") return { kind: "copy", key };
  return typeof body?.minLength === "number"
    ? { kind: "copy", key, min: body.minLength }
    : { kind: "text", text: message };
}

export function SecurityPanel() {
  const t = useTranslations("shell.securityPage");
  const tLogin = useTranslations("login");
  const requestFailed = t("requestFailed");
  // Memoized: reload() closes over it, and a fresh closure every render
  // would re-fire the load effect into a reload loop.
  const lockoutMessage = useCallback(
    (seconds: number) => tLogin("tooManyAttempts", { seconds }),
    [tLogin],
  );
  const tCommon = useTranslations("common");
  const { dateTime } = useViewerFormat();
  const router = useRouter();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; provisioningUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordNotice, setPasswordNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const reload = useCallback(() => {
    return Promise.all([
      jsonRequest("/api/auth/mfa", undefined, requestFailed, lockoutMessage),
      jsonRequest("/api/auth/sessions", undefined, requestFailed, lockoutMessage),
    ]).then(
      ([mfa, sessionResult]) => {
        setStatus(mfa);
        setSessions(sessionResult.sessions);
        setLoadError(null);
        setMessage(null);
      },
      (error: unknown) => {
        setLoadError(securityErrorMessage(error, requestFailed));
        throw error;
      },
    );
  }, [requestFailed, lockoutMessage]);

  useEffect(() => {
    void reload().then(
      () => setLoaded(true),
      (error: unknown) => {
        setLoadError(securityErrorMessage(error, requestFailed));
        setLoaded(true);
      },
    );
  }, [reload, requestFailed]);

  function retryLoad() {
    setLoaded(false);
    setLoadError(null);
    setMessage(null);
    void reload().then(
      () => setLoaded(true),
      (error: unknown) => {
        setLoadError(securityErrorMessage(error, requestFailed));
        setLoaded(true);
      },
    );
  }

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(securityErrorMessage(error, requestFailed));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword() {
    if (newPassword !== confirmNewPassword) {
      setPasswordNotice({ tone: "error", text: t("passwordsDoNotMatch") });
      return;
    }
    setBusy(true);
    setPasswordNotice(null);
    try {
      let response: Response;
      try {
        response = await fetch("/api/auth/password", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword, newPassword }),
          cache: "no-store",
        });
      } catch {
        setPasswordNotice({ tone: "error", text: requestFailed });
        return;
      }
      if (!response.ok) {
        const refusal = await passwordChangeRefusal(response, requestFailed);
        const text =
          refusal.kind === "lockout"
            ? lockoutMessage(refusal.seconds)
            : refusal.kind === "text"
              ? refusal.text
              : refusal.key === "passwordTooShort"
                ? t("passwordTooShort", { min: refusal.min ?? 0 })
                : t(refusal.key);
        setPasswordNotice({ tone: "error", text });
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordNotice({ tone: "success", text: t("passwordChanged") });
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const passwordSession = sessions.some(
    (session) => session.current && session.authMethod === "password",
  );

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {loaded && !loadError && passwordSession ? (
        <Card>
          <CardContent className="space-y-5 p-6">
            <div>
              <h2 className="text-lg font-semibold text-slate-950 dark:text-white">
                {t("changePasswordTitle")}
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {t("changePasswordDescription")}
              </p>
            </div>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void changePassword();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="change-current-password">{t("currentPassword")}</Label>
                <Input
                  id="change-current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="change-new-password">{t("newPassword")}</Label>
                <Input
                  id="change-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="change-confirm-password">{t("confirmNewPassword")}</Label>
                <Input
                  id="change-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmNewPassword}
                  onChange={(event) => setConfirmNewPassword(event.target.value)}
                />
              </div>
              {passwordNotice ? (
                <p
                  className={`text-sm ${passwordNotice.tone === "error" ? "text-red-600 dark:text-red-400" : "text-teal-700 dark:text-teal-300"}`}
                  role={passwordNotice.tone === "error" ? "alert" : "status"}
                >
                  {passwordNotice.text}
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={busy || !currentPassword || !newPassword || !confirmNewPassword}
              >
                {t("updatePassword")}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-5 p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-950 dark:text-white">
              {t("authenticatorTitle")}
            </h2>
            <p
              className={`mt-1 text-sm ${loadError ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-400"}`}
              role={loadError ? "alert" : undefined}
            >
              {!loaded
                ? tCommon("feedback.loading")
                : loadError
                  ? loadError
                  : status?.enabled
                    ? t("enabled", { count: status.recoveryCodesRemaining })
                    : t("disabledDescription")}
            </p>
          </div>

          {loaded && loadError ? (
            <Button variant="outline" disabled={busy} onClick={retryLoad}>
              {tCommon("actions.retry")}
            </Button>
          ) : null}

          {loaded && !loadError && status !== null && !status.enabled && !setup ? (
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
              <Button
                disabled={busy || status === null || !password}
                onClick={() =>
                  void act(async () => {
                    setSetup(
                      await jsonRequest(
                        "/api/auth/mfa",
                        {
                          method: "POST",
                          body: JSON.stringify({ password }),
                        },
                        requestFailed,
                        lockoutMessage,
                      ),
                    );
                    setPassword("");
                  })
                }
              >
                {t("setupAuthenticator")}
              </Button>
            </div>
          ) : null}

          {setup && !status?.enabled ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
                <p className="text-sm font-medium text-slate-900 dark:text-white">
                  {t("setupKey")}
                </p>
                <code className="mt-2 block break-all font-mono text-sm text-teal-700 dark:text-teal-300">
                  {setup.secret}
                </code>
                <p className="mt-2 text-xs text-slate-500">{t("setupKeyHelp")}</p>
                <p className="mt-1 text-xs text-slate-500">{t("setupExpiry")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-mfa">{t("confirmCode")}</Label>
                <Input
                  id="confirm-mfa"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <Button
                disabled={busy || !code}
                onClick={() =>
                  void act(async () => {
                    const result = await jsonRequest(
                      "/api/auth/mfa",
                      { method: "PUT", body: JSON.stringify({ code }) },
                      requestFailed,
                      lockoutMessage,
                    );
                    setRecoveryCodes(result.recoveryCodes);
                    setSetup(null);
                    setCode("");
                    await reload();
                  })
                }
              >
                {t("enableMfa")}
              </Button>
            </div>
          ) : null}

          {status?.enabled ? (
            <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
              <div className="space-y-1.5">
                <Label htmlFor="security-code">{t("currentCode")}</Label>
                <Input
                  id="security-code"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="disable-password">{t("passwordRequired")}</Label>
                <Input
                  id="disable-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <Button
                variant="outline"
                disabled={busy || !password || !code}
                onClick={() =>
                  void act(async () => {
                    const result = await jsonRequest(
                      "/api/auth/mfa/recovery",
                      { method: "POST", body: JSON.stringify({ password, code }) },
                      requestFailed,
                      lockoutMessage,
                    );
                    setRecoveryCodes(result.recoveryCodes);
                    setPassword("");
                    setCode("");
                    await reload();
                  })
                }
              >
                {t("replaceRecoveryCodes")}
              </Button>
              <Button
                variant="destructive"
                disabled={busy || !password || !code}
                onClick={() =>
                  void act(async () => {
                    await jsonRequest(
                      "/api/auth/mfa",
                      { method: "DELETE", body: JSON.stringify({ password, code }) },
                      requestFailed,
                      lockoutMessage,
                    );
                    setPassword("");
                    setCode("");
                    setRecoveryCodes(null);
                    await reload();
                  })
                }
              >
                {t("disableMfa")}
              </Button>
            </div>
          ) : null}

          {recoveryCodes ? (
            <div
              className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
              role="status"
            >
              <p className="font-semibold">{t("saveRecoveryCodes")}</p>
              <p className="mt-1 text-sm">{t("recoveryCodesHelp")}</p>
              <pre className="mt-3 grid grid-cols-2 gap-1 whitespace-pre-wrap font-mono text-sm">
                {recoveryCodes.join("\n")}
              </pre>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => void navigator.clipboard.writeText(recoveryCodes.join("\n"))}
              >
                {t("copyCodes")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-950 dark:text-white">
              {t("sessionsTitle")}
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {t("sessionsDescription")}
            </p>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {loadError ? null : !loaded ? (
              <p className="py-3 text-sm text-slate-500 dark:text-slate-400">
                {tCommon("feedback.loading")}
              </p>
            ) : (
              sessions.map((session) => (
                <div key={session.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="inline-flex gap-1 text-sm font-medium text-slate-900 dark:text-white">
                      <span>{session.current ? t("thisSession") : t("browserSession")}</span>
                      <span>{session.authMethod.toUpperCase()}</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {t("lastUsed", { date: dateTime(new Date(session.lastSeenAt)) })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await jsonRequest(
                          `/api/auth/sessions/${session.id}`,
                          { method: "DELETE" },
                          requestFailed,
                          lockoutMessage,
                        );
                        if (session.current) router.push("/login");
                        else await reload();
                      })
                    }
                  >
                    {t("revoke")}
                  </Button>
                </div>
              ))
            )}
          </div>
          {loaded && !loadError && sessions.length > 1 ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await jsonRequest(
                    "/api/auth/sessions",
                    { method: "DELETE" },
                    requestFailed,
                    lockoutMessage,
                  );
                  await reload();
                })
              }
            >
              {t("revokeOtherSessions")}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {message ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
