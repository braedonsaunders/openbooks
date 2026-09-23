import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import ssh2 from "ssh2";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { encryptAccountNumber, decryptAccountNumber } from "../payments/rail-settings.ts";
import { startSftpServer, generateHostKey, type SftpResolver, type SftpServerHandle } from "./server.ts";
import { assertSftpStorageReady } from "./backend.ts";

/**
 * Ties the SFTP daemon to the database — NOTHING here comes from environment
 * variables. The daemon's runtime config (enabled / port / host key) is a
 * single `sftp_daemon` row, auto-provisioned on first use and editable in the
 * UI. Logins authenticate against per-tenant `sftp_servers` rows. Secrets reuse
 * the app's AES-256-GCM data-key envelope.
 */

export const encryptSecret = (plain: string) => encryptAccountNumber(plain);
export const decryptSecret = (stored: string) => decryptAccountNumber(stored);

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface DaemonConfig {
  enabled: boolean;
  port: number;
  hostKey: string;
  advertisedHost: string | null;
}

type DaemonRow = { enabled: boolean; port: number; host_key: string; advertised_host: string | null };

function asDaemonConfig(row: DaemonRow): DaemonConfig {
  return { enabled: row.enabled, port: row.port, hostKey: row.host_key, advertisedHost: row.advertised_host };
}

async function readDaemonRow(runner: SqlExecutor): Promise<DaemonRow | undefined> {
  const r = await runner.execute<DaemonRow>(sql`
    select enabled, port, host_key, advertised_host from sftp_daemon where id = 'default'
  `);
  return r.rows[0];
}

/** Load the singleton daemon config, provisioning it (with a fresh host key) on first use. */
export async function loadDaemonConfig(runner: SqlExecutor = db): Promise<DaemonConfig> {
  const existing = await readDaemonRow(runner);
  if (existing) return asDaemonConfig(existing);

  const hostKey = generateHostKey();
  // Concurrent first-loads race on this singleton. Losing the insert is
  // expected and benign: the winner's persisted PEM is the only host key
  // we may advertise. Same claim shape as the username mint
  // (`on conflict do nothing` + observe the stored row) — never return
  // the discarded in-memory secret. Operators pin hostKeyFingerprint of
  // whatever this function returns.
  const inserted = await runner.execute<DaemonRow>(sql`
    insert into sftp_daemon (id, enabled, port, host_key) values ('default', false, 2222, ${hostKey})
    on conflict (id) do nothing
    returning enabled, port, host_key, advertised_host
  `);
  if (inserted.rows[0]) return asDaemonConfig(inserted.rows[0]);

  const persisted = await readDaemonRow(runner);
  if (!persisted) {
    throw new Error(
      "sftp_daemon row 'default' is missing after provision; retry the load so a later read can observe the persisted host key",
    );
  }
  return asDaemonConfig(persisted);
}

/** SHA-256 fingerprint of the host public key (shown in the UI, like ssh-keygen -l). */
export function hostKeyFingerprint(hostKeyPem: string): string {
  const parsed = ssh2.utils.parseKey(hostKeyPem);
  if (parsed instanceof Error) return "";
  const pub = (parsed as { getPublicSSH(): Buffer }).getPublicSSH();
  return "SHA256:" + createHash("sha256").update(pub).digest("base64").replace(/=+$/, "");
}
type ServerRow = { id: string; orgId: string; username: string; backend: string; bucket: string | null; root_prefix: string; password_encrypted: string | null; authorized_keys: string | null };

async function loadServer(username: string): Promise<ServerRow | null> {
  // Identity bootstrap over an explicitly trusted boundary. SFTP sessions
  // arrive on the raw SSH listener with no tenant scope — the boot-started
  // daemon holds no request identity at all — and sftp_servers is FORCE RLS,
  // so an unscoped lookup sees zero rows and every valid login is rejected
  // (while a listener started from a platform-admin PATCH could inherit that
  // request's org instead). The username is globally unique, which is what
  // makes this installation-wide resolution deterministic.
  return withBypassContext(async () => {
    const r = await db.execute<ServerRow>(sql`
    select id, org_id as "orgId", username, backend, bucket, root_prefix, password_encrypted, authorized_keys
      from sftp_servers where username = ${username} and is_active limit 1
  `);
    return r.rows[0] ?? null;
  });
}
async function touch(row: { id: string; orgId: string; username: string }) {
  // The session's bookkeeping runs under the row's own tenant, independent of
  // whatever ambient scope the listener inherited from its starter. Exact row
  // identity: a zero-row outcome (concurrent deactivate/delete, or RLS
  // denying the row) fails the login instead of reporting success.
  await withOrgContext(row.orgId, async () => {
    const updated = await db.execute(sql`update sftp_servers set last_connected_at = now() where id = ${row.id} and org_id = ${row.orgId}`);
    if (updated.rowCount !== 1) {
      throw new Error(
        `refusing SFTP login for ${JSON.stringify(row.username)}: its server row is no longer present in its organization — recreate or reactivate the server and try again`,
      );
    }
  });
}
const asConfig = (row: ServerRow) => ({ id: row.id, orgId: row.orgId, username: row.username, backend: row.backend, bucket: row.bucket, rootPrefix: row.root_prefix });

export const dbResolver: SftpResolver = {
  // Side-effect free: both matchers only establish that the credential is
  // authorized and return the login's config. Recording last_connected_at
  // happens in loginSucceeded, which the daemon calls only after it has
  // ACCEPTED the session — a verified password or a verified key signature.
  // Touching here would let anyone holding the public username and key
  // refresh last_connected_at with an unsigned probe, and would record a
  // connection even for a bad signature the daemon is about to reject.
  async password(username, password) {
    const row = await loadServer(username);
    if (!row?.password_encrypted) return null;
    let expected: string;
    try { expected = decryptSecret(row.password_encrypted); } catch { return null; }
    if (!constantTimeEqual(password, expected)) return null;
    return asConfig(row);
  },
  async publicKey(username, keyAlgo, keyData) {
    const row = await loadServer(username);
    if (!row?.authorized_keys) return null;
    // Match the presented key against any authorized OpenSSH public key line.
    for (const line of row.authorized_keys.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parsed = ssh2.utils.parseKey(trimmed);
      if (parsed instanceof Error) continue;
      const pub = parsed as { type: string; getPublicSSH(): Buffer };
      if (pub.type === keyAlgo && pub.getPublicSSH().equals(keyData)) {
        return asConfig(row);
      }
    }
    return null;
  },
  async loginSucceeded(config) {
    await touch({ id: config.id, orgId: config.orgId, username: config.username });
  },
};

let handle: SftpServerHandle | null = null;
let currentPort: number | null = null;

/**
 * Start (or reconcile) the SFTP server from the DB config. Idempotent and safe
 * to call after a settings change: it restarts only when enabled/port changed.
 * No env gate — a platform administrator explicitly enabling SFTP in the UI
 * is all it takes. Fresh installations stay closed by default.
 *
 * The config source is injectable for tests; production always reads the
 * singleton DB row. Every failure propagates — a daemon that is configured
 * enabled but is not listening must never be reported as running: the PATCH
 * surface answers with a degraded response and process boot fails loudly
 * rather than silently serving a login address nothing answers on.
 *
 * Cutover is bind-first: the replacement listener binds the new port BEFORE
 * the old one closes, so a failed bind (conflicting port, bad config) leaves
 * the previously working listener untouched instead of destroying it.
 */
export async function ensureSftpServer(load: () => Promise<DaemonConfig> = loadDaemonConfig): Promise<void> {
  const cfg = await load();
  if (!cfg.enabled) {
    await stopSftpServer();
    return;
  }
  if (handle && currentPort === cfg.port) return; // already running on the right port
  // Fail closed before binding: with partial S3 configuration, or local
  // storage without an absolute OPENBOOKS_DATA_DIR shared by the web and
  // worker processes, uploads would land where the importer never looks. Name
  // the misconfiguration here instead of serving such a login. Disabled stays
  // silent — a fresh install configures nothing and must still boot.
  assertSftpStorageReady();
  const replacement = await startSftpServer({ port: cfg.port, hostKey: cfg.hostKey, resolve: dbResolver });
  const previous = handle;
  handle = replacement;
  currentPort = replacement.port;
  if (previous) await previous.close();
  console.log(`[sftp] server listening on :${replacement.port} (${hostKeyFingerprint(cfg.hostKey)})`);
}

/** Whether a listener is currently bound, and on which port. */
export function sftpListenerState(): { listening: boolean; port: number | null } {
  return { listening: handle !== null, port: currentPort };
}

export function stopSftpServer(): Promise<void> {
  const h = handle;
  handle = null;
  currentPort = null;
  return h ? h.close() : Promise.resolve();
}

/**
 * Apply a settings change on the given runner. The caller owns the atomic
 * unit — pass the transaction so the config write commits (or rolls back)
 * together with its audit evidence, and only reconcile the running listener
 * AFTER that unit commits: binding a port the database no longer says we own
 * must never survive an audit failure.
 */
export async function updateDaemonConfig(patch: { enabled?: boolean; port?: number; advertisedHost?: string | null }, userId: string, runner: SqlExecutor = db): Promise<DaemonConfig> {
  await loadDaemonConfig(runner); // ensure the row exists
  await runner.execute(sql`
    update sftp_daemon set
      enabled = coalesce(${patch.enabled ?? null}, enabled),
      port = coalesce(${patch.port ?? null}, port),
      advertised_host = ${patch.advertisedHost !== undefined ? patch.advertisedHost : sql`advertised_host`},
      updated_at = now(), updated_by = ${userId}
    where id = 'default'
  `);
  return loadDaemonConfig(runner);
}

/**
 * Marker substituted for credential material (passwords, authorized keys,
 * host keys) in audit evidence: the trail proves a secret existed without
 * ever carrying its bytes — ciphertext included.
 */
export const SFTP_AUDIT_REDACTED = "[redacted]";

/** The sftp_servers columns an audit snapshot is built from. */
export type SftpServerAuditRow = {
  name: string;
  username: string;
  backend: string;
  bucket: string | null;
  root_prefix: string;
  is_active: boolean;
  password_encrypted: string | null;
  authorized_keys: string | null;
  created_by: string | null;
  updated_by: string | null;
};

/**
 * Column-named, secret-free snapshot of an sftp_servers row for audit_log
 * before/after evidence. Credential columns collapse to the redaction marker.
 */
export function sftpServerAuditSnapshot(row: SftpServerAuditRow): Record<string, unknown> {
  return {
    name: row.name,
    username: row.username,
    backend: row.backend,
    bucket: row.bucket,
    root_prefix: row.root_prefix,
    is_active: row.is_active,
    password_encrypted: row.password_encrypted === null ? null : SFTP_AUDIT_REDACTED,
    authorized_keys: row.authorized_keys === null ? null : SFTP_AUDIT_REDACTED,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

/** Secret-free snapshot of the global daemon configuration — never the host key. */
export function sftpDaemonConfigAuditSnapshot(cfg: { enabled: boolean; port: number; advertisedHost: string | null }): Record<string, unknown> {
  return { enabled: cfg.enabled, port: cfg.port, advertised_host: cfg.advertisedHost };
}
