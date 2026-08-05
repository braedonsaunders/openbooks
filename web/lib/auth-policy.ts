import { isIP } from "node:net";

export const LOGIN_WINDOW_S = 15 * 60;
export const EMAIL_ATTEMPT_LIMIT = 10;
export const NETWORK_ATTEMPT_LIMIT = 30;
export const MFA_ATTEMPT_LIMIT = 10;
export const AUTH_EVENT_RETENTION_DAYS = 90;
export const LOGIN_CHALLENGE_TTL_S = 5 * 60;

const LOCK_THRESHOLD = 5;
const FAILURE_RESET_MS = 60 * 60 * 1000;
const LOCK_MINUTES = [5, 15, 30, 60] as const;

export type AuthRequestContext = {
  networkAddress: string | null;
  userAgent: string | null;
};

export type LockoutState = {
  failureCount: number;
  lastFailedAt: Date;
  lockedUntil: Date | null;
};

/** Production cookies can never be downgraded by configuration. */
export function useSecureCookies(environment: Record<string, string | undefined> = process.env): boolean {
  if (environment.NODE_ENV === "production") return true;
  return /^(1|true|yes)$/i.test(environment.OPENBOOKS_COOKIE_SECURE ?? "");
}

export function normalizeLoginEmail(value: string): string | null {
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (!normalized || normalized.length > 320 || !normalized.includes("@")) return null;
  return normalized;
}

/** Keep redirects same-origin and bounded; reject protocol-relative values. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function firstValidAddress(value: string | null): string | null {
  if (!value) return null;
  for (const candidate of value.split(",")) {
    const address = candidate.trim().replace(/^\[|\]$/g, "");
    if (isIP(address)) return address;
  }
  return null;
}

/**
 * Forwarded headers are security input only when the operator opts in and the
 * reverse proxy strips client-supplied copies before setting its own values.
 */
export function authRequestContext(
  request: Pick<Request, "headers">,
  environment: Record<string, string | undefined> = process.env,
): AuthRequestContext {
  const trustProxy = /^(1|true|yes)$/i.test(environment.OPENBOOKS_TRUST_PROXY ?? "");
  const networkAddress = trustProxy
    ? firstValidAddress(request.headers.get("x-forwarded-for"))
      ?? firstValidAddress(request.headers.get("x-real-ip"))
      ?? firstValidAddress(request.headers.get("cf-connecting-ip"))
    : null;
  const userAgentValue = request.headers.get("user-agent")?.trim() ?? "";
  return {
    networkAddress,
    userAgent: userAgentValue ? userAgentValue.slice(0, 1024) : null,
  };
}

/** Reject browser cross-origin mutations while retaining non-browser API clients. */
export function hasExpectedOrigin(
  request: Pick<Request, "headers" | "url">,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const supplied = request.headers.get("origin");
  if (!supplied) return true;
  try {
    const configured = environment.OPENBOOKS_APP_URL
      ? new URL(environment.OPENBOOKS_APP_URL).origin
      : new URL(request.url).origin;
    return new URL(supplied).origin === configured;
  } catch {
    return false;
  }
}

/** Escalating temporary lockout, resetting after an hour without a failure. */
export function nextLockoutState(
  previous: { failureCount: number; lastFailedAt: Date | null } | null,
  now = new Date(),
): LockoutState {
  const stale = !previous?.lastFailedAt
    || now.getTime() - previous.lastFailedAt.getTime() > FAILURE_RESET_MS;
  const failureCount = stale ? 1 : Math.max(0, previous.failureCount) + 1;
  const lockIndex = failureCount - LOCK_THRESHOLD;
  const minutes = lockIndex >= 0
    ? LOCK_MINUTES[Math.min(lockIndex, LOCK_MINUTES.length - 1)]
    : null;
  return {
    failureCount,
    lastFailedAt: now,
    lockedUntil: minutes === null ? null : new Date(now.getTime() + minutes * 60_000),
  };
}

export function retryAfterSeconds(lockedUntil: Date | null, now = new Date()): number {
  if (!lockedUntil) return 0;
  return Math.max(0, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}

/** Remaining time until the oldest attempt leaves a fixed sliding window. */
export function slidingWindowRetryAfter(
  oldestAttempt: Date | null,
  windowSeconds = LOGIN_WINDOW_S,
  now = new Date(),
): number {
  if (!oldestAttempt) return windowSeconds;
  const expiresAt = oldestAttempt.getTime() + windowSeconds * 1000;
  return Math.max(1, Math.ceil((expiresAt - now.getTime()) / 1000));
}
