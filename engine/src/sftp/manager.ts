import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import ssh2 from "ssh2";
import { db, type SqlExecutor } from "../db.ts";
import { encryptAccountNumber, decryptAccountNumber } from "../payments.ts";
import { startSftpServer, generateHostKey, type SftpResolver, type SftpServerHandle } from "./server.ts";

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

/** Load the singleton daemon config, provisioning it (with a fresh host key) on first use. */
export async function loadDaemonConfig(runner: SqlExecutor = db): Promise<DaemonConfig> {
  const r = (await runner.execute<{ enabled: boolean; port: number; host_key: string; advertised_host: string | null }>(sql`
    select enabled, port, host_key, advertised_host from sftp_daemon where id = 'default'
  `));
  if (r.rows[0]) {
    const c = r.rows[0];
    return { enabled: c.enabled, port: c.port, hostKey: c.host_key, advertisedHost: c.advertised_host };
  }
  const hostKey = generateHostKey();
  await runner.execute(sql`
    insert into sftp_daemon (id, enabled, port, host_key) values ('default', false, 2222, ${hostKey})
    on conflict (id) do nothing
  `);
  return { enabled: false, port: 2222, hostKey, advertisedHost: null };
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
  const r = (await db.execute<ServerRow>(sql`
    select id, org_id as "orgId", username, backend, bucket, root_prefix, password_encrypted, authorized_keys
      from sftp_servers where username = ${username} and is_active limit 1
  `));
  return r.rows[0] ?? null;
}
async function touch(row: ServerRow) {
  await db.execute(sql`update sftp_servers set last_connected_at = now() where id = ${row.id} and org_id = ${row.orgId}`);
}
const asConfig = (row: ServerRow) => ({ id: row.id, username: row.username, backend: row.backend, bucket: row.bucket, rootPrefix: row.root_prefix });

export const dbResolver: SftpResolver = {
  async password(username, password) {
    const row = await loadServer(username);
    if (!row?.password_encrypted) return null;
    let expected: string;
    try { expected = decryptSecret(row.password_encrypted); } catch { return null; }
    if (!constantTimeEqual(password, expected)) return null;
    await touch(row);
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
        await touch(row);
        return asConfig(row);
      }
    }
    return null;
  },
};

let handle: SftpServerHandle | null = null;
let currentPort: number | null = null;

/**
 * Start (or reconcile) the SFTP daemon from the DB config. Idempotent and safe
 * to call after a settings change: it restarts only when enabled/port changed.
 * No env gate — a platform administrator explicitly enabling SFTP in the UI
 * is all it takes. Fresh installations stay closed by default.
 */
export async function ensureSftpServer(): Promise<void> {
  let cfg: DaemonConfig;
  try { cfg = await loadDaemonConfig(); } catch (e) {
    console.error("[sftp] could not load daemon config:", (e as Error).message);
    return;
  }
  if (!cfg.enabled) {
    await stopSftpServer();
    return;
  }
  if (handle && currentPort === cfg.port) return; // already running on the right port
  await stopSftpServer();
  try {
    handle = await startSftpServer({ port: cfg.port, hostKey: cfg.hostKey, resolve: dbResolver });
    currentPort = handle.port;
    console.log(`[sftp] server listening on :${handle.port} (${hostKeyFingerprint(cfg.hostKey)})`);
  } catch (e) {
    console.error("[sftp] failed to start:", (e as Error).message);
  }
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
