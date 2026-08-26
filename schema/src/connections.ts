/**
 * The connection audit envelope deliberately accepts only the non-secret
 * projection of a connection row. Credential material is represented by
 * presence/change booleans; the sealed blob itself is never copied.
 */
export interface ConnectionAuditRow {
  source: string;
  displayName: string;
  authKind: string;
  status: string;
  lastError?: string | null;
  config: unknown;
  secrets?: unknown;
  mirrorEnabled: boolean;
  mirrorSchedule: string;
  postedChangePolicy: string;
  postedChangeAuthorizedBy?: string | null;
  postedChangeAuthorizedAt?: Date | string | null;
}

export interface ConnectionAuditSnapshot {
  source: string;
  displayName: string;
  authKind: string;
  status: string;
  lastError: string | null;
  config: unknown;
  credentials: { configured: boolean };
  mirror: { enabled: boolean; schedule: string };
  postedChange: {
    policy: string;
    authorizedBy: string | null;
    authorizedAt: string | null;
  };
}

const SENSITIVE_CONFIG_KEY =
  /secret|token|password|credential|authorization|api.?key|private.?key/i;
const SEALED_VALUE = /^enc:v\d+:/i;

function sanitizeConfigValue(value: unknown): unknown {
  if (typeof value === "string" && SEALED_VALUE.test(value)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) return value.map(sanitizeConfigValue);
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_CONFIG_KEY.test(key)
        ? "[redacted]"
        : sanitizeConfigValue(nested);
    }
    return sanitized;
  }
  return value;
}

/** Defense in depth for legacy or malformed config rows that contain secrets. */
export function sanitizeConnectionConfig(
  config: unknown,
): unknown {
  return sanitizeConfigValue(config);
}

export function connectionAuditSnapshot(
  row: ConnectionAuditRow,
): ConnectionAuditSnapshot {
  const authorizedAt = row.postedChangeAuthorizedAt;
  return {
    source: row.source,
    displayName: row.displayName,
    authKind: row.authKind,
    status: row.status,
    lastError: row.lastError ?? null,
    config: sanitizeConnectionConfig(row.config),
    credentials: { configured: row.secrets != null },
    mirror: {
      enabled: row.mirrorEnabled,
      schedule: row.mirrorSchedule,
    },
    postedChange: {
      policy: row.postedChangePolicy,
      authorizedBy: row.postedChangeAuthorizedBy ?? null,
      authorizedAt:
        authorizedAt instanceof Date
          ? authorizedAt.toISOString()
          : authorizedAt ?? null,
    },
  };
}

export function connectionAuditChanges(args: {
  event: "connection_created" | "connection_updated" | "connection_deleted" | "oauth_connected";
  before: ConnectionAuditRow | null;
  after: ConnectionAuditRow | null;
  credentialsChanged: boolean;
}): {
  event: typeof args.event;
  before: ConnectionAuditSnapshot | null;
  after: ConnectionAuditSnapshot | null;
  credentialsChanged: boolean;
} {
  return {
    event: args.event,
    before: args.before ? connectionAuditSnapshot(args.before) : null,
    after: args.after ? connectionAuditSnapshot(args.after) : null,
    credentialsChanged: args.credentialsChanged,
  };
}
